import { CodexRpc } from './rpc.js';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, resolve } from 'node:path';

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
export function createClient(rpc, { binary, cwd, model } = {}) {
  const loaded = new Set();
  const options = { cwd, approvalPolicy: 'never', sandbox: 'workspace-write', ...(model ? { model } : {}) };
  function thread(existingId) {
    return { async runStreamed(prompt, { signal } = {}) {
      return { events: (async function* () {
        const result = await rpc.request(existingId ? 'thread/resume' : 'thread/start', { ...options, ...(existingId ? { threadId: existingId } : {}) });
        const threadId = result.thread.id;
        loaded.add(threadId);
        yield { type: 'thread.started', thread_id: threadId };
        if (signal?.aborted) return;
        const queue = [], items = new Map();
        let wake, ended = false, failure, turnId, interrupting = false, interruptTimer;
        const push = event => { queue.push(event); wake?.(); };
        const fail = error => { failure = error; ended = true; wake?.(); };
        const interrupt = () => {
          if (!turnId || interrupting || ended) return;
          interrupting = true;
          interruptTimer = setTimeout(() => fail(new Error('Codex did not finish interrupting the turn. Retry deletion.')), 30000);
          rpc.request('turn/interrupt', { threadId, turnId }).catch(fail);
        };
        const convert = item => {
          if (item.type === 'agentMessage') return { id: item.id, type: 'agent_message', text: item.text || '' };
          if (item.type === 'commandExecution') return { id: item.id, type: 'command_execution', command: item.command, aggregated_output: item.aggregatedOutput || '', exit_code: item.exitCode };
        };
        const notify = ({ method, params: p }) => {
          if (p?.threadId !== threadId) return;
          if (method === 'turn/started') { turnId = p.turn.id; if (signal?.aborted) interrupt(); }
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
        rpc.on('notification', notify); rpc.on('failure', fail); signal?.addEventListener('abort', interrupt);
        try {
          const started = await rpc.request('turn/start', { threadId, input: [{ type: 'text', text: prompt }] });
          turnId = started.turn.id;
          if (signal?.aborted) interrupt();
          while (true) {
            while (queue.length) yield queue.shift();
            if (failure) throw failure;
            if (ended) break;
            await new Promise(resolve => { wake = resolve; }); wake = null;
          }
        } finally {
          clearTimeout(interruptTimer);
          signal?.removeEventListener('abort', interrupt); rpc.off('notification', notify); rpc.off('failure', fail);
        }
      })() };
    } };
  }
  return {
    binary, model: model || 'Auto · local Codex default',
    start: () => thread(), resume: id => thread(id),
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
