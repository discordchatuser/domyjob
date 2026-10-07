import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { createApp } from './app.js';

test('streams, persists, resumes and rejects overlapping turns', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'codex-chat-'));
  let release;
  let gate = Promise.resolve();
  const resumed = [];
  const deleted = [];
  let cleanupFails = false;
  const prompts = [];
  const signals = [];
  const thread = { async runStreamed(prompt, options) { prompts.push(prompt); signals.push(options.signal); return { events: (async function* () {
    yield { type: 'thread.started', thread_id: 'local-thread-1' };
    await Promise.race([gate, new Promise(resolve => { if (options.signal.aborted) resolve(); else options.signal.addEventListener('abort', resolve, { once: true }); })]);
    yield { type: 'item.completed', item: { id: 'shell', type: 'command_execution', command: 'ls -la', aggregated_output: 'files', exit_code: 0 } };
    yield { type: 'item.completed', item: { id: 'a', type: 'agent_message', text: 'Hello' } };
    yield { type: 'turn.completed' };
  })() }; } };
  const getCodex = async () => ({ deleteThread: async id => { if (cleanupFails) throw new Error('Cleanup failed'); deleted.push(id); }, model: 'Auto', binary: '/local/codex', start: () => thread, resume: id => { resumed.push(id); return thread; } });
  let server;
  async function start() {
    server = await createApp({ getCodex, dataDir });
    return 'http://local';
  }
  // Exercise the actual HTTP handler without binding sockets (sandbox forbids listen).
  const fetch = async (url, options = {}) => {
    const req = Readable.from(options.body ? [options.body] : []);
    req.url = new URL(url).pathname;
    req.method = options.method || 'GET';
    req.headers = Object.fromEntries(Object.entries(options.headers || {}).map(([key, value]) => [key.toLowerCase(), value]));
    const chunks = [];
    let ready;
    const response = new Promise(resolve => { ready = resolve; });
    let finish;
    const finished = new Promise(resolve => { finish = resolve; });
    const res = new Writable({ write(chunk, encoding, callback) { chunks.push(chunk.toString()); callback(); } });
    res.headersSent = false;
    const result = { status: 200, text: async () => { await finished; return chunks.join(''); }, json: async () => JSON.parse(await result.text()) };
    res.writeHead = status => { result.status = status; res.headersSent = true; ready(result); };
    res.on('finish', finish);
    server.emit('request', req, res);
    return response;
  };
  const post = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try {
    let base = await start();
    const chat = await (await post(base + '/api/chats', {})).json();
    const endpoint = base + `/api/chats/${chat.id}/messages`;
    assert.equal((await post(endpoint, { prompt: '' })).status, 400);
    gate = new Promise(resolve => { release = resolve; });
    const first = await post(endpoint, { prompt: 'Hi' });
    assert.equal((await post(endpoint, { prompt: 'Overlap' })).status, 409);
    release();
    const events = (await first.text()).trim().split('\n').map(JSON.parse);
    assert.equal(events.find(e => e.type === 'message').text, 'Hello');
    assert.equal(events.at(-1).chat.threadId, 'local-thread-1');
    assert.equal(events.at(-1).chat.busy, false);
    base = await start();
    const restored = await (await fetch(base + '/api/chats')).json();
    assert.equal(restored[0].messages.length, 3);
    await (await post(base + `/api/chats/${chat.id}/messages`, { prompt: '', commands: ['ls -la'] })).text();
    assert.deepEqual(resumed, ['local-thread-1']);
    assert.match(prompts[1], /Run these shell commands/);
    assert.match(prompts[1], /ls -la/);
    assert.equal(events.find(event => event.type === 'command').output, 'files');
    assert.equal(events.find(event => event.type === 'command').exitCode, 0);
    const saved = await (await fetch(base + '/api/chats')).json();
    assert.deepEqual(saved[0].messages[3].commands, ['ls -la']);
    assert.equal((await post(base + `/api/chats/${chat.id}/messages`, { prompt: '', commands: [42] })).status, 400);
    const denied = await fetch(base + '/api/chats', { method: 'POST', headers: { Origin: 'https://example.com' } });
    assert.equal(denied.status, 403);
    cleanupFails = true;
    assert.equal((await fetch(base + '/api/chats/' + chat.id, { method: 'DELETE' })).status, 500);
    assert.equal((await (await fetch(base + '/api/chats')).json()).length, 1);
    cleanupFails = false;
    assert.equal((await fetch(base + '/api/chats/' + chat.id, { method: 'DELETE' })).status, 200);
    assert.deepEqual(deleted, ['local-thread-1']);
    base = await start();
    assert.deepEqual(await (await fetch(base + '/api/chats')).json(), []);
    assert.equal((await fetch(base + '/api/chats/' + chat.id, { method: 'DELETE' })).status, 404);
    const active = await (await post(base + '/api/chats', {})).json();
    gate = new Promise(resolve => { release = resolve; });
    const activeResponse = await post(base + `/api/chats/${active.id}/messages`, { prompt: 'Run something' });
    // The first stream frame precedes SDK iteration; let it enter runStreamed.
    await new Promise(resolve => setImmediate(resolve));
    assert.equal((await fetch(base + '/api/chats/' + active.id, { method: 'DELETE' })).status, 200);
    assert.equal(signals.at(-1).aborted, true);
    release(); await activeResponse.text();
    base = await start();
    assert.deepEqual(await (await fetch(base + '/api/chats')).json(), []);
  } finally {
    release?.();
    await rm(dataDir, { recursive: true, force: true });
  }
});
