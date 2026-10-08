import { randomUUID } from 'node:crypto';
import { askUserTool, validateQuestions, validateAnswers } from './questions.js';
import { CodexRpc } from './rpc.js';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, resolve } from 'node:path';
import { loadRoutingSkill, routingPrompt, routingSchema, chooseRoute } from './model-route.js';

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
export function createClient(rpc, { binary, cwd, model, routing = true } = {}) {
  const loaded = new Set();
  const pendingQuestions = new Map();
  const options = { cwd, approvalPolicy: 'never', sandbox: 'workspace-write', ...(model ? { model } : {}) };
  function thread(existingId, workdir = cwd) {
    return { async runStreamed(prompt, { signal, orchestrator = false } = {}) {
      return { events: (async function* () {
        const skill = routing ? await loadRoutingSkill() : null;
        const instructions = questionInstructions + (orchestrator ? '\n\n' + orchestratorInstructions : '') + (skill ? '\nBefore every user task, the application runs a ROUTING PREFLIGHT ONLY turn. During that turn, only classify difficulty as requested and return the required JSON; do not ask questions or perform the task. During the execution turn, the routing decision has already been applied; proceed with the task.\n\n' + skill.instructions : '');
        const result = await rpc.request(existingId ? 'thread/resume' : 'thread/start', { ...options, cwd: workdir, developerInstructions: instructions, ...(existingId ? { threadId: existingId } : { dynamicTools: [askUserTool] }) });
        const threadId = result.thread.id;
        loaded.add(threadId);
        yield { type: 'thread.started', thread_id: threadId };
        if (signal?.aborted) return;
        const queue = [], items = new Map();
        let wake, ended = false, failure, turnId, interrupting = false, interruptTimer, assessing = Boolean(skill);
        const assessmentItems = new Map();
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
            return { id: item.id, type: 'activity', label: 'Called ' + item.server + '/' + item.tool, output: item.error?.message || '', status: item.status };
          }
          if (item.type === 'collabAgentToolCall') {
            const labels = { spawnAgent: 'Spawned subagent', sendInput: 'Directed subagent', resumeAgent: 'Resumed subagent', wait: 'Waiting for subagents', closeAgent: 'Closed subagent' };
            const states = Object.entries(item.agentsStates || {}).map(([id, state]) => id + ': ' + state.status + (state.message ? '\n' + state.message : ''));
            return { id: item.id, type: 'activity', label: labels[item.tool] || 'Subagent activity', output: [item.prompt, ...states].filter(Boolean).join('\n\n'), status: item.status === 'inProgress' ? 'in_progress' : item.status };
          }
          if (item.type === 'commandExecution') return { id: item.id, type: 'command_execution', command: item.command, aggregated_output: item.aggregatedOutput || '', exit_code: item.exitCode, status: item.status, duration_ms: item.durationMs };
        };
        const requestInput = request => {
          const p = request.params;
          if (p?.threadId !== threadId) return;
          if (assessing) {
            rpc.send({ id: request.id, error: { code: -32602, message: 'Routing preflight must return a difficulty assessment without tools.' } }); return;
          }
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
          if (p?.threadId !== threadId) return;
          if (method === 'serverRequest/resolved') {
            for (const [id, question] of pendingQuestions) if (question.threadId === threadId && question.rpcId === p.requestId) { pendingQuestions.delete(id); push({ type: 'questions.resolved', requestId: id }); }
          }
          if (method === 'turn/started') { turnId = p.turn.id; if (signal?.aborted) interrupt(); }
          if (assessing) {
            if (['item/started', 'item/completed'].includes(method) && p.item.type === 'agentMessage') assessmentItems.set(p.item.id, { text: p.item.text || '', phase: p.item.phase });
            if (method === 'item/agentMessage/delta') { const item = assessmentItems.get(p.itemId) || { text: '' }; assessmentItems.set(p.itemId, { ...item, text: item.text + p.delta }); }
            if (method === 'turn/completed') {
              if (p.turn.status === 'failed') failure = new Error(p.turn.error?.message || 'Difficulty assessment failed');
              if (p.turn.status === 'interrupted') failure = new Error('Difficulty assessment interrupted');
              ended = true; wake?.();
            }
            return;
          }
          if (method === 'item/started' || method === 'item/completed') {
            const item = convert(p.item);
            if (item) { items.set(item.id, item); push({ type: method === 'item/started' ? 'item.started' : 'item.completed', item }); }
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
          let route;
          if (skill) {
            yield { type: 'model.routing' };
            const available = [];
            let cursor;
            do {
              const page = await rpc.request('model/list', { includeHidden: false, ...(cursor ? { cursor } : {}) });
              available.push(...page.data); cursor = page.nextCursor;
            } while (cursor);
            if (signal?.aborted) return;
            const classifier = available.find(item => item.model === skill.models.medium) || available.find(item => item.isDefault) || available[0];
            if (!classifier) throw new Error('No models are available for difficulty assessment.');
            const started = await rpc.request('turn/start', { threadId, model: classifier.model, sandboxPolicy: { type: 'readOnly', networkAccess: false }, input: [{ type: 'text', text: routingPrompt(prompt, skill) }], outputSchema: routingSchema });
            turnId = started.turn.id;
            if (signal?.aborted) interrupt();
            while (!ended) { await new Promise(resolve => { wake = resolve; }); wake = null; }
            if (signal?.aborted) return;
            if (failure) throw failure;
            const responses = [...assessmentItems.values()];
            const text = responses.findLast(item => item.phase === 'final')?.text || responses.at(-1)?.text || '';
            route = chooseRoute(text, skill, available, model);
            // Reset the turn overrides used for the read-only assessment before execution.
            await rpc.request('thread/resume', { ...options, threadId, cwd: workdir, model: route.model, developerInstructions: instructions });
            if (signal?.aborted) return;
            ended = false; failure = undefined; turnId = undefined; interrupting = false; clearTimeout(interruptTimer);
          }
          assessing = false;
          const started = await rpc.request('turn/start', { threadId, ...(route ? { model: route.model } : {}), input: [{ type: 'text', text: prompt }] });
          turnId = started.turn.id;
          if (route) yield { type: 'model.changed', route };
          else if (result.model) yield { type: 'model.changed', route: { model: result.model } };
          if (signal?.aborted) interrupt();
          while (true) {
            while (queue.length) yield queue.shift();
            if (failure) throw failure;
            if (ended) break;
            await new Promise(resolve => { wake = resolve; }); wake = null;
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
    binary, cwd, model: model || 'Auto · local Codex default',
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
    return createClient(rpc, { binary, cwd: resolve(process.env.CODEX_WORKDIR || process.cwd()), model: process.env.CODEX_MODEL });
  } catch (error) { rpc.close(); throw error; }
}
