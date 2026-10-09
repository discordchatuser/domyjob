import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import { applyStreamEvent, recordAnswer } from './chat-state.js';

const require = createRequire(import.meta.url);
const compiled = await build({
  stdin: { contents: "export { default as App } from './App.jsx';", resolveDir: new URL('.', import.meta.url).pathname, loader: 'jsx' },
  bundle: true, write: false, format: 'esm', platform: 'node',
  plugins: [{ name: 'shared-react', setup(builder) { builder.onResolve({ filter: /^react(?:\/|$)/ }, args => ({ path: pathToFileURL(require.resolve(args.path)).href, external: true })); } }],
});

const request = { requestId: 'q1', questions: [{ id: 'style', question: 'Choose a style', options: [{ label: 'Minimal', description: 'Quiet layout' }, { label: 'Bold', description: 'Strong colors' }] }] };
const answer = { role: 'user', text: 'Choose a style\nBold', questionResponse: { ...request, answers: { style: { answers: ['Bold'] } } } };

test('stream updates preserve questions and answers are deduplicated across completion races', () => {
  let chat = { id: 'one', messages: [], pendingQuestions: [] };
  chat = applyStreamEvent(chat, { type: 'questions', request });
  chat = applyStreamEvent(chat, { type: 'questions', request });
  chat = applyStreamEvent(chat, { type: 'message', id: 'reply', text: 'Working' });
  assert.equal(chat.pendingQuestions.length, 1);
  assert.equal(chat.stream.reply.text, 'Working');
  chat = applyStreamEvent(chat, { type: 'done', chat: { ...chat, messages: [answer], pendingQuestions: [] } });
  chat = recordAnswer(chat, request.requestId, answer);
  assert.equal(chat.messages.length, 1);
  assert.deepEqual(chat.stream, {});
});

test('React chat preserves choices and drafts, retries answers, streams replies, supports gallery and voice', async () => {
  const dom = new JSDOM('<div id="app"></div>', { url: 'http://localhost' });
  const original = new Map();
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })) {
    original.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  let recognition;
  dom.window.SpeechRecognition = class {
    constructor() { recognition = this; }
    start() { this.onaudiostart(); }
    stop() { this.onend(); }
    abort() {}
  };
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { act } = React;
  const { App } = await import('data:text/javascript;base64,' + Buffer.from(compiled.outputFiles[0].text).toString('base64'));
  let chats = [
    { id: 'one', title: 'First thread', messages: [{ role: 'user', text: 'Oldest request' }, { role: 'assistant', text: 'Assistant reply' }, { role: 'user', text: 'Question response', questionResponse: { requestId: 'answered', questions: [], answers: {} } }, { role: 'user', text: 'Latest request\nWith details' }], pendingQuestions: [request], images: [{ id: 'img1', url: '/first.png', prompt: 'First image' }, { id: 'img2', url: '/second.png' }] },
    { id: 'two', title: 'Second thread', messages: [], pendingQuestions: [], images: [] },
  ];
  let stream, rejectAnswer = true;
  const submissions = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    if (url === '/api/status') return Response.json({ ready: true, model: 'Test model', routingConfigured: true, models: [{ model: 'gpt-6-luna', displayName: 'Luna' }, { model: 'gpt-6-astra', displayName: 'Astra' }] });
    if (url === '/api/chats') return Response.json(chats);
    if (url.endsWith('/questions/q1')) {
      submissions.push(JSON.parse(options.body));
      if (rejectAnswer) { rejectAnswer = false; return Response.json({ error: 'Please retry' }, { status: 400 }); }
      chats = chats.map(chat => chat.id === 'one' ? recordAnswer(chat, 'q1', answer) : chat);
      return Response.json({ answered: true, message: answer });
    }
    if (url.endsWith('/messages')) {
      submissions.push(JSON.parse(options.body));
      return new Response(new ReadableStream({ start(controller) { stream = controller; } }));
    }
    throw new Error('Unexpected request: ' + url);
  };
  const root = createRoot(document.getElementById('app'));
  const click = async element => { assert.ok(element); await act(async () => { element.click(); }); };
  const type = async (element, value) => act(async () => {
    const prototype = element.tagName === 'TEXTAREA' ? dom.window.HTMLTextAreaElement.prototype : dom.window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, value);
    element.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });
  const emit = async event => act(async () => { stream.enqueue(new TextEncoder().encode(JSON.stringify(event) + '\n')); await new Promise(resolve => setTimeout(resolve, 0)); });
  try {
    await act(async () => { root.render(React.createElement(App)); });
    assert.equal(document.querySelector('#model').textContent, 'Test model');
    const schemePicker = document.querySelector('select[aria-label="Color scheme"]');
    assert.equal(schemePicker.value, 'slate');
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLSelectElement.prototype, 'value').set.call(schemePicker, 'sand');
      schemePicker.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    });
    assert.equal(document.querySelector('.app-shell').dataset.theme, 'sand');
    assert.equal(window.localStorage.getItem('color-scheme'), 'sand');
    assert.ok(document.querySelector('.composer-actions #send'));
    const prompt = document.querySelector('#prompt');
    const arrow = async (key, options = {}) => { const event = new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options }); await act(async () => prompt.dispatchEvent(event)); return event; };
    await type(prompt, 'Unsent draft');
    assert.equal((await arrow('ArrowUp')).defaultPrevented, true);
    assert.equal(prompt.value, 'Latest request\nWith details');
    await arrow('ArrowUp'); assert.equal(prompt.value, 'Oldest request');
    await arrow('ArrowUp'); assert.equal(prompt.value, 'Oldest request');
    await arrow('ArrowDown'); assert.equal(prompt.value, 'Latest request\nWith details');
    await arrow('ArrowDown'); assert.equal(prompt.value, 'Unsent draft');
    assert.equal((await arrow('ArrowDown')).defaultPrevented, false);
    await type(prompt, 'First line\nSecond line');
    prompt.setSelectionRange(prompt.value.length, prompt.value.length);
    assert.equal((await arrow('ArrowUp')).defaultPrevented, false, 'normal multiline cursor movement must remain available');
    prompt.setSelectionRange(0, 0);
    await arrow('ArrowUp'); assert.equal(prompt.value, 'Latest request\nWith details');
    assert.equal((await arrow('ArrowUp', { shiftKey: true })).defaultPrevented, false);
    await arrow('ArrowDown'); assert.equal(prompt.value, 'First line\nSecond line');
    prompt.setSelectionRange(0, 0); await arrow('ArrowUp');
    await click([...document.querySelectorAll('#threads button')].find(button => button.textContent === 'Second thread'));
    await type(prompt, 'Other conversation draft');
    await arrow('ArrowUp'); assert.equal(prompt.value, 'Other conversation draft');
    await click([...document.querySelectorAll('#threads button')].find(button => button.textContent === 'First thread'));
    await arrow('ArrowDown'); assert.equal(prompt.value, 'First line\nSecond line');
    prompt.setSelectionRange(0, 0); await arrow('ArrowUp');
    await type(prompt, 'Edited recalled message');
    await arrow('ArrowDown'); assert.equal(prompt.value, 'Edited recalled message');
    await type(prompt, '');


    await click(document.querySelector('input[value="Bold"]'));
    assert.ok(document.querySelector('.question-card'));
    assert.equal(submissions.length, 0, 'selecting an option must not submit');
    await type(document.querySelector('#prompt'), 'First draft');
    await click([...document.querySelectorAll('#threads button')].find(button => button.textContent === 'Second thread'));
    await type(document.querySelector('#prompt'), 'Second draft');
    await click([...document.querySelectorAll('#threads button')].find(button => button.textContent === 'First thread'));
    assert.equal(document.querySelector('#prompt').value, 'First draft');
    assert.ok(document.querySelector('input[value="Bold"]').checked);
    await click(document.querySelector('.question-card button'));
    assert.match(document.querySelector('.question-error').textContent, /Please retry/);
    assert.ok(document.querySelector('input[value="Bold"]').checked);
    await click(document.querySelector('.question-card button'));
    assert.equal(document.querySelector('.answered-question strong').textContent, 'Bold');
    assert.equal(document.querySelector('form.question-card'), null);
    assert.equal(submissions[1].answers.style.answers[0], 'Bold');

    await click(document.querySelector('#gallery'));
    assert.ok(document.querySelector('dialog').open);
    await click(document.querySelector('.gallery-next'));
    assert.equal(document.querySelector('.gallery-full').getAttribute('src'), '/second.png');
    await click(document.querySelector('.gallery-controls button'));
    assert.equal(document.querySelector('dialog'), null);

    await click(document.querySelector('#dictate'));
    assert.ok(document.querySelector('#prompt').readOnly);
    await act(async () => recognition.onresult({ results: [[{ transcript: 'dictated text' }]] }));
    await click(document.querySelector('#dictate'));
    assert.equal(document.querySelector('#prompt').value, 'First draft dictated text');
    assert.equal(document.querySelector('#prompt').readOnly, false);
    const modelPicker = document.querySelector('select[aria-label="Task model"]');
    assert.equal(modelPicker.options.length, 3);
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLSelectElement.prototype, 'value').set.call(modelPicker, 'gpt-6-astra');
      modelPicker.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    });
    await click(document.querySelector('#send'));
    assert.equal(submissions.at(-1).prompt, 'First draft dictated text');
    assert.equal(submissions.at(-1).model, 'gpt-6-astra');
    await emit({ type: 'model.routing' });
    assert.match(document.querySelector('#model').textContent, /Choosing task model/);
    const route = { model: 'gpt-6-astra', tier: 'hard', reason: 'JEV model selection.', source: 'jev', confidence: .9 };
    const modelMessage = { role: 'model', modelRoute: { ...route, previousModel: 'gpt-6.1-sol' } };
    await emit({ type: 'model.changed', route, message: modelMessage });
    assert.equal(document.querySelector('#model').textContent, 'gpt-6-astra · hard');
    assert.match(document.querySelector('.model-change').textContent, /gpt-6.1-sol → gpt-6-astra/);
    assert.match(document.querySelector('.model-change').textContent, /JEV · 90% confidence/);
    await click([...document.querySelectorAll('#threads button')].find(button => button.textContent === 'Second thread'));
    assert.equal(document.querySelector('#model').textContent, 'Test model');
    await click([...document.querySelectorAll('#threads button')].find(button => button.textContent === 'First thread'));
    assert.equal(document.querySelector('#model').textContent, 'gpt-6-astra · hard');
    await emit({ type: 'questions', request: { ...request, requestId: 'q2' } });
    await click(document.querySelector('input[value="Minimal"]'));
    const input = document.querySelector('input[value="Minimal"]');
    await emit({ type: 'message', id: 'reply', text: 'Streamed reply' });
    assert.equal(document.querySelector('input[value="Minimal"]'), input, 'streaming must preserve the mounted input');
    assert.ok(input.checked);
    assert.match(document.querySelector('#messages').textContent, /Streamed reply/);
    await emit({ type: 'done', chat: { ...chats[0], model: route.model, modelRoute: route, messages: [answer, modelMessage, { role: 'assistant', text: 'Finished' }], pendingQuestions: [], busy: false } });
    await act(async () => { stream.close(); });
    assert.equal(document.querySelector('#send').disabled, false);
    assert.match(document.querySelector('#messages').textContent, /Finished/);
    assert.doesNotMatch(document.querySelector('#messages').textContent, /Streamed reply/);
  } finally {
    await act(async () => root.unmount());
    globalThis.fetch = previousFetch;
    dom.window.close();
    for (const [key, descriptor] of original) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; }
  }
});

test('projects use one orchestrator, preserve drafts and leave thread controls to General', async () => {
  const dom = new JSDOM('<div id="app"></div>', { url: 'http://localhost' });
  const original = new Map();
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })) {
    original.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  window.localStorage.setItem('color-scheme', 'midnight');
  const previousFetch = globalThis.fetch;
  const chats = [{ id: 'a', title: 'Trophy design', cwd: '/work/TROPHY', messages: [] }, { id: 'b', title: 'Other task', cwd: '/work/OTHER', messages: [] }];
  let createdCwd, taskStream;
  globalThis.fetch = async (url, options) => {
    if (url === '/api/status') return Response.json({ ready: true, model: 'Test', models: [{ model: 'test-model', displayName: 'Test' }] });
    if (url === '/api/chats' && options?.method === 'POST') { createdCwd = JSON.parse(options.body).cwd; return Response.json({ ...chats[0], orchestrator: true }); }
    if (url === '/api/chats/a/messages') return new Response(new ReadableStream({ start(controller) { taskStream = controller; } }));
    if (url === '/api/chats') return Response.json(chats);
    if (url.includes('/project/content')) return Response.json({ documents: [], tasks: [{ id: 'clarify', title: 'Replace Email', description: 'Show contact cards', status: 'todo', phase: 'Project', docs: [], assessment: { needsClarification: true } }], warnings: [] });
    throw new Error('Unexpected request ' + url);
  };
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { App } = await import('data:text/javascript;base64,' + Buffer.from(compiled.outputFiles[0].text).toString('base64'));
  const root = createRoot(document.getElementById('app'));
  const click = async node => { assert.ok(node); await React.act(async () => node.click()); };
  try {
    await React.act(async () => root.render(React.createElement(App)));
    assert.equal(document.querySelector('.app-shell').dataset.theme, 'midnight');
    assert.equal(document.querySelector('#threads'), null);
    assert.equal(document.querySelector('#new'), null);
    assert.equal(document.querySelector('#title').textContent, 'Project orchestrator');
    assert.equal(document.querySelector('.workspace-header'), null);
    assert.ok(document.querySelector('.workspace-sidebar [aria-label="Project views"]'));
    assert.equal(document.querySelector('[aria-label="Project views"]').getAttribute('aria-orientation'), 'vertical');
    assert.equal(document.querySelector('[aria-label="Task model"]'), null);
    const prompt = document.querySelector('#prompt');
    await React.act(async () => { Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value').set.call(prompt, 'Keep draft'); prompt.dispatchEvent(new dom.window.Event('input', { bubbles: true })); });
    const projectTab = name => [...document.querySelectorAll('[aria-label="Projects"] button')].find(node => node.textContent.includes(name));
    await click(projectTab('OTHER'));
    assert.equal(document.querySelector('#threads'), null);
    assert.equal(document.querySelector('#prompt').value, '');
    await click(projectTab('TROPHY'));
    assert.equal(document.querySelector('#prompt').value, 'Keep draft');
    await click([...document.querySelectorAll('[aria-label="Project views"] button')].find(node => node.textContent === 'Documents'));
    assert.equal(document.querySelector('.document-workspace').hidden, false);
    assert.equal(document.querySelector('.task-board'), null);
    assert.equal(document.querySelector('.chat-panel').hidden, true);
    const chatTab = [...document.querySelectorAll('[aria-label="Project views"] button')].find(node => node.textContent === 'Chat');
    await click(chatTab);
    assert.equal(chatTab.getAttribute('aria-selected'), 'true');
    assert.equal(document.querySelector('.chat-panel').hidden, false);
    assert.equal(document.querySelector('.project-surface').hidden, true);
    assert.equal(document.querySelector('#prompt').value, 'Keep draft');
    assert.equal(document.querySelector('#new'), null);
    assert.equal(createdCwd, undefined);
    await click(projectTab('General'));
    assert.ok(document.querySelector('#new'));
    assert.ok(document.querySelector('#threads'));
    assert.ok(document.querySelector('[aria-label="Task model"]'));
    await click(projectTab('TROPHY'));
    assert.equal(document.querySelector('#prompt').value, 'Keep draft');
    await click([...document.querySelectorAll('[aria-label="Project views"] button')].find(node => node.textContent === 'Tasks'));
    await click(document.querySelector('.task-card'));
    const run = [...document.querySelectorAll('dialog button')].find(node => node.textContent === 'Run task');
    assert.equal(run.disabled, false, 'tasks needing clarification can start');
    await click(run);
    assert.equal(document.querySelector('.chat-panel').hidden, false);
    assert.equal(document.querySelector('dialog'), null);
    const emit = async event => React.act(async () => { taskStream.enqueue(new TextEncoder().encode(JSON.stringify(event) + '\n')); });
    await emit({ type: 'chat', chat: { ...chats[0], orchestrator: true, busy: true, pendingQuestions: [] } });
    await emit({ type: 'questions', request });
    assert.ok(document.querySelector('form.question-card'), 'task clarification appears in the orchestrator chat');
    assert.equal(document.querySelector('#prompt').value, 'Keep draft');
    await emit({ type: 'done', chat: { ...chats[0], orchestrator: true, busy: false, pendingQuestions: [] } });
    await React.act(async () => taskStream.close());
  } finally {
    await React.act(async () => root.unmount()); globalThis.fetch = previousFetch; dom.window.close();
    for (const [key, descriptor] of original) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; }
  }
});
