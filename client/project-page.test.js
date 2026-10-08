import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';
const require = createRequire(import.meta.url);
const compiled = await build({
  stdin: { contents: "export { ProjectPage } from './project-page.jsx';", resolveDir: new URL('.', import.meta.url).pathname, loader: 'jsx' },
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
  const oldFetch = globalThis.fetch;
  const documents = [{ path: 'docs/guide.md', type: 'md' }, { path: 'docs/setup.md', type: 'md' }, { path: 'spec.pdf', type: 'pdf' }];
  let scans = 0;
  globalThis.fetch = async url => {
    if (url.includes('/content')) { scans++; return { ok: true, json: async () => ({ documents, tasks: [{ id: '1', title: 'Verify live sender', status: 'blocked', phase: '01-foundation', source: 'docs/guide.md', docs: ['docs/guide.md', 'docs/setup.md'], description: 'Waiting for sender' }], warnings: [] }) }; }
    const file = new URL(url, 'http://localhost').searchParams.get('file');
    return { ok: true, text: async () => file === 'docs/setup.md' ? '# Setup instructions' : '# Project guide\n\n[Setup](setup.md)\n\n<script>window.pwned=true</script>\n\n| Task | State |\n| --- | --- |\n| Mail | Pending |' };
  };
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { ProjectPage } = await import('data:text/javascript;base64,' + Buffer.from(compiled.outputFiles[0].text).toString('base64'));
  const root = createRoot(document.getElementById('app'));
  async function flush() { await React.act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); }); }
  async function click(node) { assert.ok(node); await React.act(async () => node.click()); await flush(); }
  try {
    await React.act(async () => root.render(React.createElement(ProjectPage, { cwd: '/project' })));
    await flush();
    assert.equal(document.querySelectorAll('.blocked .task-card').length, 1);
    assert.equal(document.querySelector('.markdown-reader h1').textContent, 'Project guide');
    assert.ok(document.querySelector('.markdown-reader table'));
    assert.equal(document.querySelector('.markdown-reader script'), null);
    assert.equal(window.pwned, undefined);
    await click(document.querySelector('.task-card'));
    assert.match(document.querySelector('.task-detail').textContent, /Waiting for sender/);
    await click(document.querySelector('.markdown-reader a'));
    assert.equal(document.querySelector('.markdown-reader h1').textContent, 'Setup instructions');
    await click([...document.querySelectorAll('.document-list button')].find(node => node.textContent.includes('spec.pdf')));
    assert.match(document.querySelector('iframe').src, /file=spec.pdf/);
    await click([...document.querySelectorAll('button')].find(node => node.textContent === 'Refresh from disk'));
    assert.equal(scans, 2);
  } finally {
    await React.act(async () => root.unmount()); dom.window.close(); globalThis.fetch = oldFetch;
    for (const [key, descriptor] of original) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; }
  }
});
