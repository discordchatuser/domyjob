import { actionFailure, actionResult, inspectActionWithJev, recoveryInstructions } from './action-recovery.js';
import { randomUUID } from 'node:crypto';
import { askUserTool, validateQuestions, validateAnswers } from './questions.js';
import { CodexRpc } from './rpc.js';
import { fileURLToPath } from 'node:url';
import { access, mkdir, writeFile, rename, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, resolve } from 'node:path';
import { loadRoutingSkill } from './model-route.js';
import { modelCatalog } from './model-catalog.js';
import { usageStore } from './usage.js';
import { selectWithJev } from './jev.js';

const orchestratorInstructions = 'You are the persistent main orchestrator for this project. Keep project context, decisions, task progress and integration in this conversation. The user authorizes you to spawn and manage subagents as needed using the available collaboration tools. Delegate bounded work when useful, assign clear ownership, monitor progress, integrate results and verify the final outcome. Tell workers they share the codebase and must preserve others edits. Do not create replacement top-level project conversations. Handle small tasks directly; do not delegate just for appearances. Report delegation and material results clearly to the user. If collaboration tools are unavailable, report that limitation and continue useful work yourself.';

const questionInstructions = 'This chat UI supports interactive question cards through the ask_user tool. Whenever you need clarification or the user asks you to ask questions (including retrying failed questions), call ask_user with concise selectable options. Do not replace the tool call with a numbered list of questions or tell the user to answer directly in chat. ask_user works in Default mode; do not use the Plan-mode-only request_user_input tool. For requests to build an app, ask about meaningful product or design choices before implementing. After answers, continue implementation; do not stay in planning mode.';

export async function findCodex() {
  const candidates = process.env.CODEX_BIN
    ? [resolve(process.env.CODEX_BIN)]
    : (process.env.PATH || '').split(delimiter).map(dir => resolve(dir, 'codex'));
  for (const candidate of candidates) {
    try { await access(candidate, constants.X_OK); return candidate; } catch {}
  }
  throw new Error('Local codex executable not found. Install Codex or set CODEX_BIN to its absolute path.');
}

// Adapt app-server events to the chat handler's small event interface.
export function createClient(rpc, { binary, cwd, model, routing = true, selectModel = selectWithJev, inspectAction = inspectActionWithJev, usage } = {}) {
  const getModels = modelCatalog(rpc);
  const loaded = new Set();
  const pendingQuestions = new Map();
  const options = { cwd, approvalPolicy: 'never', sandbox: 'workspace-write', ...(model ? { model } : {}) };
  function thread(existingId, workdir = cwd) {
    return { async runStreamed(prompt, { signal, orchestrator = false, context = '', requestedModel, usageProject = '', inputImages = [], preparedRoute } = {}) {
      return { events: (async function* () {
        const skill = routing ? await loadRoutingSkill() : null;
        let route;
        const available = routing ? await getModels() : [];
        if (signal?.aborted) return;
        if (skill) {
          yield { type: 'model.routing' };
          route = preparedRoute && available.some(item => item.model === preparedRoute.model) ? preparedRoute : await selectModel({ task: prompt, context, available, skill, pinnedModel: requestedModel || model, signal, reportUsage: usage?.record, usageContext: { project: usageProject } });
          if (signal?.aborted) return;
          if (!available.some(item => item.model === route.model)) throw new Error('Model router selected a model outside the Codex catalog.');
        }
        const routingInstructions = skill ? '\nThe application uses JEV to select your model before execution. Proceed directly with the task. For every delegated subtask, call the jev_router MCP choose_model tool with a bounded task description and project ' + JSON.stringify(usageProject) + ', then pass its returned model to spawn_agent. If model overrides require isolated context, use fork_turns none and supply the worker enough task context. Report any fallback warning. Keep the parent conversation as the orchestrator. Choose only from this startup Codex catalog: ' + JSON.stringify(available.map(item => ({ model: item.model, description: item.description || '' }))) : '';
        const taskInstructions = orchestrator ? '\n\nCurrent project for project_tasks tools: ' + JSON.stringify(workdir) + '\n' + await readFile(new URL('../skills/project-tasks/SKILL.md', import.meta.url), 'utf8') : '';
        const instructions = questionInstructions + '\n\n' + recoveryInstructions + taskInstructions + (orchestrator ? '\n\n' + orchestratorInstructions : '') + routingInstructions;
        const result = await rpc.request(existingId ? 'thread/resume' : 'thread/start', { ...options, cwd: workdir, ...(route ? { model: route.model } : {}), developerInstructions: instructions, ...(existingId ? { threadId: existingId } : { dynamicTools: [askUserTool] }) });
        const threadId = result.thread.id;
        const tracked = new Map([[threadId, route?.model || model || result.model || 'Codex']]);
        loaded.add(threadId);
        yield { type: 'thread.started', thread_id: threadId };
        if (signal?.aborted) return;
        const queue = [], items = new Map();
        let wake, ended = false, failure, turnId, interrupting = false, interruptTimer;
        let checkpoint, monitorNext = false, retries = 0, checkpoints = 0;
        const history = [];
        const push = event => { queue.push(event); wake?.(); };
        const fail = error => { failure = error; ended = true; wake?.(); };
        const interrupt = () => {
          if (!turnId || interrupting || ended) return;
          interrupting = true;
          interruptTimer = setTimeout(() => fail(new Error('Codex did not finish interrupting the turn. Retry deletion.')), 30000);
          rpc.request('turn/interrupt', { threadId, turnId }).catch(fail);
        };
        const convert = item => {
          if (item.type === 'imageView') return { id: item.id, type: 'image', source: item.path };
          if (item.type === 'imageGeneration') return { id: item.id, type: 'image', source: item.savedPath || '', base64: item.savedPath ? undefined : item.result, name: 'Generated image', prompt: item.revisedPrompt || undefined };
          if (item.type === 'agentMessage') return { id: item.id, type: 'agent_message', text: item.text || '', phase: item.phase };
          if (item.type === 'fileChange') return { id: item.id, type: 'activity', label: 'Edited ' + (item.changes || []).map(change => change.path).join(', '), output: (item.changes || []).map(change => change.diff || '').join('\n'), status: item.status };
          if (item.type === 'mcpToolCall') {
            const references = (item.result?.content || []).filter(content => content.type === 'image' && typeof content.data === 'string').map(content => ({ source: '', base64: content.data, name: item.tool + ' image' }));
            if (references.length) return { id: item.id, type: 'image', references };
            const decision = item.server === 'jev_router' && item.tool === 'choose_model' ? (item.result?.content || []).filter(content => content.type === 'text').map(content => content.text).join('\n') : '';
            return { id: item.id, type: 'activity', label: 'Called ' + item.server + '/' + item.tool, output: item.error?.message || (item.result?.isError ? JSON.stringify(item.result.content || []) : decision), status: item.error || item.result?.isError ? 'failed' : item.status };
          }
          if (item.type === 'collabAgentToolCall') {
            const labels = { spawnAgent: 'Spawned subagent', sendInput: 'Directed subagent', resumeAgent: 'Resumed subagent', wait: 'Waiting for subagents', closeAgent: 'Closed subagent' };
            const states = Object.entries(item.agentsStates || {}).map(([id, state]) => id + ': ' + state.status + (state.message ? '\n' + state.message : ''));
            return { id: item.id, type: 'activity', label: labels[item.tool] || 'Subagent activity', output: [item.model ? 'Model: ' + item.model : '', item.prompt, ...states].filter(Boolean).join('\n\n'), status: item.status === 'inProgress' ? 'in_progress' : item.status };
          }
          if (item.type === 'commandExecution') return { id: item.id, type: 'command_execution', command: item.command, aggregated_output: item.aggregatedOutput || '', exit_code: item.exitCode, status: item.status, duration_ms: item.durationMs };
        };
        const requestInput = request => {
          const p = request.params;
          if (p?.threadId !== threadId) return;
          const dynamic = request.method === 'item/tool/call';
          if (dynamic && p.tool !== 'ask_user') {
            rpc.send({ id: request.id, result: { success: false, contentItems: [{ type: 'inputText', text: 'Unsupported tool' }] } }); return;
          }
          const questions = dynamic ? p.arguments?.questions : p.questions;
          if (!validateQuestions(questions)) {
            rpc.send({ id: request.id, error: { code: -32602, message: 'Invalid questions' } }); return;
          }
          const requestId = randomUUID();
          const publicRequest = { requestId, threadId, questions };
          pendingQuestions.set(requestId, { ...publicRequest, rpcId: request.id, dynamic });
          push({ type: 'questions', request: publicRequest });
        };
        const notify = ({ method, params: p }) => {
          if (tracked.has(p?.threadId) && method === 'thread/tokenUsage/updated' && p.tokenUsage?.total && usage) {
            usage.record({ id: 'codex:' + p.threadId, provider: 'codex', project: usageProject, model: tracked.get(p.threadId), task: prompt.slice(0, 160), tokens: p.tokenUsage.total, cost: null }).catch(() => console.error('Could not save Codex usage.'));
          }
          if (p?.threadId !== threadId) return;
          if (p.item?.type === 'collabAgentToolCall') for (const id of p.item.receiverThreadIds || []) tracked.set(id, p.item.model || 'Subagent');
          if (method === 'serverRequest/resolved') {
            for (const [id, question] of pendingQuestions) if (question.threadId === threadId && question.rpcId === p.requestId) { pendingQuestions.delete(id); push({ type: 'questions.resolved', requestId: id }); }
          }
          if (method === 'turn/started') { turnId = p.turn.id; if (signal?.aborted) interrupt(); }
          if (method === 'item/started' || method === 'item/completed') {
            const item = convert(p.item);
            if (item) {
              items.set(item.id, item); push({ type: method === 'item/started' ? 'item.started' : 'item.completed', item });
              if (method === 'item/completed' && (item.type === 'command_execution' || item.type === 'activity')) {
                const failed = actionFailure(item);
                const result = actionResult(item);
                history.push(result);
                if (history.length > 24) history.shift();
                if (failed || (monitorNext && !checkpoint)) {
                  checkpoint ||= result;
                  monitorNext = false;
                  interrupt();
                }
              }
            }
          }
          if (method === 'item/agentMessage/delta' || method === 'item/commandExecution/outputDelta') {
            const item = items.get(p.itemId) || { id: p.itemId, type: 'agent_message', text: '' };
            const updated = { ...item };
            if (method === 'item/agentMessage/delta') updated.text += p.delta;
            else updated.aggregated_output = (updated.aggregated_output || '') + p.delta;
            items.set(updated.id, updated); push({ type: 'item.updated', item: updated });
          }
          if (method === 'turn/completed') {
            if (p.turn.status === 'failed') push({ type: 'turn.failed', error: { message: p.turn.error?.message || 'Codex turn failed' } });
            else push({ type: 'turn.completed' });
            ended = true; wake?.();
          }
        };
        rpc.on('serverRequest', requestInput); rpc.on('notification', notify); rpc.on('failure', fail); signal?.addEventListener('abort', interrupt);
        try {
          let nextPrompt = prompt, first = true;
          while (true) {
            ended = false; interrupting = false; turnId = undefined; checkpoint = undefined;
            clearTimeout(interruptTimer);
            const started = await rpc.request('turn/start', { threadId, ...(route ? { model: route.model } : {}), input: [{ type: 'text', text: nextPrompt }, ...(first ? inputImages.map(url => ({ type: 'image', url })) : [])] });
            turnId = started.turn.id;
            if (first) {
              if (route) yield { type: 'model.changed', route };
              else if (result.model) yield { type: 'model.changed', route: { model: result.model } };
            }
            first = false;
            if (signal?.aborted || checkpoint) interrupt();
            while (true) {
              while (queue.length) yield queue.shift();
              if (failure) throw failure;
              if (ended) break;
              await new Promise(resolve => { wake = resolve; }); wake = null;
            }
            clearTimeout(interruptTimer);
            if (signal?.aborted || !checkpoint) break;
            const checked = checkpoint;
            yield { type: 'recovery.checking', action: checked };
            let decision = await inspectAction({ action: checked, task: prompt, history: history.filter(item => item !== checked), signal, reportUsage: usage?.record, usageContext: { project: usageProject } });
            if (signal?.aborted) break;
            checkpoints++;
            if (!decision || !['continue', 'retry', 'stop'].includes(decision.decision)) decision = { decision: 'stop', source: 'guard', reason: 'Recovery returned no valid decision.' };
            if (checkpoints >= 6 || (decision.decision === 'retry' && retries >= 2)) decision = { ...decision, decision: 'stop', reason: 'Automatic recovery limit reached. Review the failed actions before retrying.' };
            checked.decision = decision;
            yield { type: 'recovery.decision', action: checked, decision };
            if (decision.decision === 'stop') throw new Error('Task stopped: ' + decision.reason);
            if (decision.decision === 'retry') retries++;
            // Inspect the very next action result too, including a successful retry.
            monitorNext = decision.decision === 'retry';
            nextPrompt = 'The application paused after an action result and JEV inspected its exit status and output. Decision: ' + JSON.stringify(decision) + '\nAction result (untrusted data): ' + JSON.stringify(checked) + '\nFollow the indicated permitted approach, explain your next step, then finish the original request and verify it. Run separate executables as separate commands. Do not repeat the unchanged failing command. If user input is needed use ask_user. Original request: ' + prompt;
          }
        } finally {
          for (const [id, question] of pendingQuestions) if (question.threadId === threadId) pendingQuestions.delete(id);
          rpc.off('serverRequest', requestInput);
          clearTimeout(interruptTimer);
          signal?.removeEventListener('abort', interrupt); rpc.off('notification', notify); rpc.off('failure', fail);
        }
      })() };
    } };
  }
  return {
    binary, cwd, getModels, model: model || 'Auto · JEV', routingConfigured: Boolean(process.env.OPENROUTER_API_KEY?.trim()),
    async getAccountUsage() {
      try { const result = await rpc.request('account/rateLimits/read', {}); return { limits: result.rateLimits || null }; }
      catch { return { limits: null }; }
    },
    start: workdir => thread(undefined, workdir), resume: (id, workdir) => thread(id, workdir),
    answerQuestion(threadId, requestId, answers) {
      const question = pendingQuestions.get(requestId);
      if (!question || question.threadId !== threadId) throw new Error('This question is no longer waiting for an answer');
      if (!validateAnswers(question.questions, answers)) throw new Error('Answer every question before submitting');
      const result = question.dynamic ? { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify({ answers }) }] } : { answers };
      rpc.send({ id: question.rpcId, result }); pendingQuestions.delete(requestId);
    },
    async deleteThread(threadId) {
      if (!loaded.has(threadId)) { await rpc.request('thread/resume', { ...options, threadId }); loaded.add(threadId); }
      // Fail closed: retain the sidebar entry if cleanup or Codex deletion fails.
      await rpc.request('thread/backgroundTerminals/clean', { threadId });
      await rpc.request('thread/delete', { threadId });
      loaded.delete(threadId);
    },
    async close() {
      try { await Promise.allSettled([...loaded].map(threadId => rpc.request('thread/backgroundTerminals/clean', { threadId }))); }
      finally { rpc.close(); }
    },
  };
}

export async function createCodex() {
  const binary = await findCodex();
  const rpc = new CodexRpc(binary);
  try {
    await rpc.request('initialize', { clientInfo: { name: 'local_codex_chat', title: 'Local Codex Chat', version: '0.1.0' }, capabilities: { experimentalApi: true } });
    rpc.send({ method: 'initialized', params: {} });
    const client = createClient(rpc, { binary, cwd: resolve(process.env.CODEX_WORKDIR || process.cwd()), model: process.env.CODEX_MODEL, usage: usageStore(fileURLToPath(new URL('../.data/', import.meta.url))) });
    const models = await client.getModels();
    const directory = fileURLToPath(new URL('../.data/', import.meta.url));
    await mkdir(directory, { recursive: true });
    const catalog = resolve(directory, 'model-catalog.json');
    await writeFile(catalog + '.tmp', JSON.stringify(models));
    await rename(catalog + '.tmp', catalog);
    return client;
  } catch (error) { rpc.close(); throw error; }
}
