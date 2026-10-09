import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';
const require = createRequire(import.meta.url);
const compiled = await build({
  stdin: { contents: "export { ProjectPage } from './project-page.jsx'; export { TaskGraph } from './task-graph.jsx';", resolveDir: new URL('.', import.meta.url).pathname, loader: 'jsx' },
  bundle: true, write: false, format: 'esm', platform: 'node',
  plugins: [{ name: 'shared-react', setup(builder) { builder.onResolve({ filter: /^react(?:\/|$)/ }, args => ({ path: pathToFileURL(require.resolve(args.path)).href, external: true })); } }],
});
test('project page shows source tasks, renders Markdown safely, navigates local docs and embeds PDF', async () => {
  const dom = new JSDOM('<div id="app"></div>', { url: 'http://localhost' });
  const original = new Map();
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })) {
    original.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  const oldFetch = globalThis.fetch;
  const documents = [{ path: 'docs/guide.md', type: 'md' }, { path: 'docs/setup.md', type: 'md' }, { path: 'spec.pdf', type: 'pdf' }];
  let scans = 0;
  let savedTask;
  let sourceTask = { id: '1', title: 'Verify live sender', status: 'blocked', phase: '01-foundation', source: 'docs/guide.md', docs: ['docs/guide.md', 'docs/setup.md'], description: 'Waiting for sender' };
  globalThis.fetch = async (url, options) => {
    if (url === '/api/project/tasks') { savedTask = JSON.parse(options.body); if (savedTask.id === sourceTask.id) sourceTask = { ...sourceTask, ...savedTask }; return { ok: true, json: async () => savedTask }; }
    if (url.includes('/content')) { scans++; return { ok: true, json: async () => ({ documents, tasks: [sourceTask], warnings: [] }) }; }
    const file = new URL(url, 'http://localhost').searchParams.get('file');
    return { ok: true, text: async () => file === 'docs/setup.md' ? '# Setup instructions' : '# Project guide\n\n[Setup](setup.md)\n\n<script>window.pwned=true</script>\n\n| Task | State |\n| --- | --- |\n| Mail | Pending |' };
  };
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { ProjectPage, TaskGraph } = await import('data:text/javascript;base64,' + Buffer.from(compiled.outputFiles[0].text).toString('base64'));
  const root = createRoot(document.getElementById('app'));
  async function flush() { await React.act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); }); }
  async function click(node) { assert.ok(node); await React.act(async () => node.click()); await flush(); }
  try {
    await React.act(async () => root.render(React.createElement(ProjectPage, { cwd: '/project' })));
    await flush();
    assert.equal(document.querySelectorAll('.blocked .task-card').length, 1);
    assert.equal(document.querySelector('.task-graph'), null);
    assert.equal(document.querySelector('[aria-label="Project audit log"]'), null);
    assert.equal(document.querySelector('.document-workspace').hidden, true);
    assert.equal(document.querySelector('.markdown-reader h1').textContent, 'Project guide');
    assert.ok(document.querySelector('.markdown-reader table'));
    assert.equal(document.querySelector('.markdown-reader script'), null);
    assert.equal(window.pwned, undefined);
    await click(document.querySelector('.task-card'));
    assert.match(document.querySelector('.task-detail').textContent, /Waiting for sender/);
    assert.equal(document.querySelector('.task-more').open, false);
    await click(document.querySelector('dialog[aria-label="Verify live sender"] button'));
    await React.act(async () => root.render(React.createElement(ProjectPage, { cwd: '/project', section: 'docs' })));
    assert.equal(document.querySelector('.task-board'), null);
    assert.equal(document.querySelector('.document-workspace').hidden, false);
    await click(document.querySelector('.markdown-reader a'));
    assert.equal(document.querySelector('.markdown-reader h1').textContent, 'Setup instructions');
    await click([...document.querySelectorAll('.document-list button')].find(node => node.textContent.includes('spec.pdf')));
    assert.match(document.querySelector('iframe').src, /file=spec.pdf/);
    await React.act(async () => root.render(React.createElement(ProjectPage, { cwd: '/project', section: 'tasks' })));
    await click([...document.querySelectorAll('button')].find(node => node.getAttribute('aria-label') === 'Refresh from disk'));
    assert.equal(scans, 2);
    await click([...document.querySelectorAll('button')].find(node => node.textContent === 'New task'));
    const modal = document.querySelector('dialog[aria-label="New task"]');
    assert.ok(modal.open);
    assert.equal(modal.querySelector('input[type="file"]').multiple, true);
    await click([...modal.querySelectorAll('button')].find(node => node.textContent === 'Open text viewer'));
    assert.ok(document.querySelector('dialog[aria-label="Task viewer"]').open);
    await click(document.querySelector('dialog[aria-label="Task viewer"] button'));
    await click([...modal.querySelectorAll('button')].find(node => node.textContent === 'Cancel'));
    assert.equal(document.querySelector('dialog'), null);
    await click(document.querySelector('.task-card'));
    await click([...document.querySelectorAll('button')].find(node => node.textContent === 'Edit task'));
    const editor = document.querySelector('dialog[aria-label="Edit task"]');
    await click([...editor.querySelectorAll('button')].find(node => node.textContent === 'Open text viewer'));
    const viewer = document.querySelector('dialog[aria-label="Task viewer"]');
    const range = document.createRange();
    range.setStart(viewer.querySelector('.task-viewer-text').firstChild, 0);
    range.setEnd(viewer.querySelector('.task-viewer-text').firstChild, 7);
    window.getSelection().removeAllRanges(); window.getSelection().addRange(range);
    await click([...viewer.querySelectorAll('button')].find(node => node.textContent === 'Highlight selection'));
    assert.equal(viewer.querySelector('mark').textContent, 'Waiting');
    await click(viewer.querySelector('button'));
    await React.act(async () => editor.querySelector('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })));
    await flush();
    assert.deepEqual(savedTask.highlights, [{ start: 0, end: 7 }]);
    assert.equal(document.querySelector('dialog'), null);
    await click([...document.querySelectorAll('.task-view-nav button')].find(node => node.textContent === 'Graph'));
    assert.ok(document.querySelector('.task-graph'));
    assert.equal(document.querySelector('.task-board'), null);
    await click([...document.querySelectorAll('.task-view-nav button')].find(node => node.textContent === 'History'));
    assert.ok(document.querySelector('[aria-label="Project audit log"]'));
    assert.equal(document.querySelector('.task-graph'), null);
    await click([...document.querySelectorAll('.task-view-nav button')].find(node => node.textContent === 'Board'));
    const transfer = { setData() {}, effectAllowed: '', dropEffect: '' };
    async function drag(node, type) { const event = new window.Event(type, { bubbles: true, cancelable: true }); Object.defineProperty(event, 'dataTransfer', { value: transfer }); await React.act(async () => node.dispatchEvent(event)); }
    await drag(document.querySelector('.task-card'), 'dragstart');
    await drag(document.querySelector('.board-column.done'), 'dragover');
    assert.ok(document.querySelector('.board-column.done.drop-target'));
    await drag(document.querySelector('.board-column.done'), 'drop'); await flush();
    assert.equal(savedTask.status, 'done');
    assert.equal(document.querySelectorAll('.done .task-card').length, 1);
    await click(document.querySelector('.task-card'));
    const status = document.querySelector('select[aria-label="Task status"]');
    await React.act(async () => { Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set.call(status, 'todo'); status.dispatchEvent(new window.Event('change', { bubbles: true })); }); await flush();
    assert.equal(savedTask.status, 'todo');
    assert.equal(document.querySelectorAll('.todo .task-card').length, 1);
    const scansBeforeChat = scans;
    await React.act(async () => root.render(React.createElement(ProjectPage, { cwd: '/project', section: 'chat', active: false })));
    assert.equal(scans, scansBeforeChat);
    sourceTask = { ...sourceTask, title: 'Captured from chat' };
    await React.act(async () => root.render(React.createElement(ProjectPage, { cwd: '/project', section: 'tasks', active: true, contentVersion: 1 }))); await flush();
    assert.equal(scans, scansBeforeChat + 1);
    assert.match(document.querySelector('.task-card').textContent, /Captured from chat/);
    let selectedGraphTask;
    const graphTasks = [
      { id: 'email', title: 'Add Email', status: 'done', phase: 'Project' },
      { id: 'sms', title: 'Replace Email with SMS', description: 'Use SMS', status: 'done', phase: 'Project', assessment: { impact: 'replace', status: 'evaluated', route: { model: 'test-model' }, relationships: [{ taskId: 'email', type: 'supersedes', confidence: .9 }] }, execution: { id: 'run', status: 'completed', updatedAt: new Date().toISOString(), outcome: 'Changed notification settings and verified SMS' } },
    ];
    await React.act(async () => root.render(React.createElement(TaskGraph, { tasks: graphTasks, onSelect: value => { selectedGraphTask = value; } })));
    assert.equal(document.querySelectorAll('.graph-node').length, 6);
    assert.equal(document.querySelector('.graph-link-label').textContent, 'supersedes');
    await React.act(async () => document.querySelectorAll('.graph-node')[3].dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
    await click([...document.querySelectorAll('.graph-details button')].find(node => node.textContent === 'Open task'));
    assert.equal(selectedGraphTask.id, 'sms');
    assert.match(document.querySelector('.graph-details').textContent, /Changed notification settings and verified SMS/);



  } finally {
    await React.act(async () => root.unmount()); dom.window.close(); globalThis.fetch = oldFetch;
    for (const [key, descriptor] of original) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; }
  }
});
