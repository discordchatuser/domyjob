import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, stat, realpath } from 'node:fs/promises';
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
  let askQuestion = false;
  let emitRouting = false;
  let answerRelease;
  const chosenAnswers = [];
  const prompts = [];
  const signals = [];
  const thread = { async runStreamed(prompt, options) { prompts.push(prompt); signals.push(options.signal); return { events: (async function* () {
    yield { type: 'thread.started', thread_id: 'local-thread-1' };
    if (emitRouting) {
      yield { type: 'model.routing' };
      yield { type: 'model.changed', route: { tier: 'medium', model: 'gpt-6.1-sol', reason: 'Several connected decisions.' } };
    }
    if (askQuestion) {
      const answered = new Promise(resolve => { answerRelease = resolve; });
      yield { type: 'questions', request: { requestId: 'question-1', questions: [{ id: 'style', question: 'Choose a style', options: [{ label: 'Minimal' }, { label: 'Colorful' }] }] } };
      await answered;
    }
    await Promise.race([gate, new Promise(resolve => { if (options.signal.aborted) resolve(); else options.signal.addEventListener('abort', resolve, { once: true }); })]);
    yield { type: 'item.completed', item: { id: 'shell', type: 'command_execution', command: 'ls -la', aggregated_output: 'files', exit_code: 0 } };
    yield { type: 'item.completed', item: { id: 'a', type: 'agent_message', text: 'Hello' } };
    yield { type: 'item.completed', item: { id: 'image-1', type: 'image', source: '', base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aFOsAAAAASUVORK5CYII=', name: 'Test image' } };
    yield { type: 'turn.completed' };
  })() }; } };
  const getCodex = async () => ({ answerQuestion: (threadId, requestId, answers) => { chosenAnswers.push({ threadId, requestId, answers }); answerRelease(); }, deleteThread: async id => { if (cleanupFails) throw new Error('Cleanup failed'); deleted.push(id); }, model: 'Auto', binary: '/local/codex', start: () => thread, resume: id => { resumed.push(id); return thread; } });
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
    assert.equal(restored[0].messages.length, 4);
    assert.equal(restored[0].images.length, 1);
    const image = restored[0].images[0];
    const imagePath = join(dataDir, 'images', chat.id, image.id);
    assert.ok((await readFile(imagePath)).length > 0);
    assert.equal((await fetch(base + image.url)).status, 200);
    assert.equal((await fetch(base + `/api/chats/${chat.id}/images/${'0'.repeat(64)}.png`)).status, 404);
    assert.equal(restored[0].messages[1].role, 'tool');
    assert.equal(restored[0].messages[1].output, 'files');
    assert.equal(restored[0].messages[1].exitCode, 0);
    await (await post(base + `/api/chats/${chat.id}/messages`, { prompt: '', commands: ['ls -la'] })).text();
    assert.deepEqual(resumed, ['local-thread-1']);
    assert.match(prompts[1], /Run these shell commands/);
    assert.match(prompts[1], /ls -la/);
    assert.equal(events.find(event => event.type === 'command').output, 'files');
    assert.equal(events.find(event => event.type === 'command').exitCode, 0);
    const saved = await (await fetch(base + '/api/chats')).json();
    assert.deepEqual(saved[0].messages[4].commands, ['ls -la']);
    assert.equal((await post(base + `/api/chats/${chat.id}/messages`, { prompt: '', commands: [42] })).status, 400);
    const denied = await fetch(base + '/api/chats', { method: 'POST', headers: { Origin: 'https://example.com' } });
    assert.equal(denied.status, 403);
    cleanupFails = true;
    assert.equal((await fetch(base + '/api/chats/' + chat.id, { method: 'DELETE' })).status, 500);
    assert.equal((await (await fetch(base + '/api/chats')).json()).length, 1);
    assert.ok((await stat(imagePath)).isFile());
    cleanupFails = false;
    assert.equal((await fetch(base + '/api/chats/' + chat.id, { method: 'DELETE' })).status, 200);
    assert.deepEqual(deleted, ['local-thread-1']);
    await assert.rejects(stat(join(dataDir, 'images', chat.id)), { code: 'ENOENT' });
    assert.equal((await fetch(base + image.url)).status, 404);
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
    askQuestion = true;
    emitRouting = true;
    const interactive = await (await post(base + '/api/chats', { cwd: dataDir })).json();
    assert.equal(interactive.orchestrator, true);
    const duplicateProject = await (await post(base + '/api/chats', { cwd: dataDir })).json();
    assert.equal(duplicateProject.id, interactive.id);
    assert.equal((await (await fetch(base + '/api/chats')).json()).length, 1);
    assert.equal(interactive.cwd, await realpath(dataDir));
    const interactiveResponse = await post(base + `/api/chats/${interactive.id}/messages`, { prompt: 'Build a todo app' });
    // Wait until the handler has consumed the question event and saved the thread id.
    const questionDeadline = Date.now() + 3000;
    while (Date.now() < questionDeadline) {
      const list = await (await fetch(base + '/api/chats')).json();
      if (list[0].pendingQuestions.length) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const questionState = await (await fetch(base + '/api/chats')).json();
    assert.equal(questionState[0].model, 'gpt-6.1-sol');
    assert.equal(questionState[0].routing, false);
    assert.equal(questionState[0].pendingQuestions[0].questions[0].question, 'Choose a style');
    assert.equal((await post(base + `/api/chats/${interactive.id}/questions/question-1`, { answers: { style: { answers: ['Colorful'] } } })).status, 200);
    await interactiveResponse.text();
    assert.equal(chosenAnswers[0].answers.style.answers[0], 'Colorful');
    assert.equal((await post(base + `/api/chats/${interactive.id}/questions/question-1`, { answers: {} })).status, 409);
    const history = await (await fetch(base + '/api/chats')).json();
    assert.equal(history[0].pendingQuestions.length, 0);
    assert.ok(history[0].messages.some(message => message.text?.includes('Colorful')));
    const answered = history[0].messages.find(message => message.questionResponse);
    assert.equal(answered.questionResponse.requestId, 'question-1');
    assert.equal(answered.questionResponse.answers.style.answers[0], 'Colorful');
    assert.equal(answered.questionResponse.questions[0].options[1].label, 'Colorful');
    base = await start();
    const reloaded = await (await fetch(base + '/api/chats')).json();
    assert.equal(reloaded[0].modelRoute.tier, 'medium');
    assert.equal(reloaded[0].messages.find(message => message.modelRoute).modelRoute.model, 'gpt-6.1-sol');
  } finally {
    release?.();
    await rm(dataDir, { recursive: true, force: true });
  }
});
