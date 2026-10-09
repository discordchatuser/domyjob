import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { projectContent, readDocument } from './project-content.js';

test('indexes planning docs and PDF, honors incomplete checkpoint evidence over roadmap checks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'project-content-'));
  const phase = '.planning/phases/01-foundation';
  try {
    await mkdir(join(root, phase), { recursive: true });
    await mkdir(join(root, 'node_modules'));
    await writeFile(join(root, 'node_modules/hidden.md'), '# Skip dependency');
    await writeFile(join(root, '.planning/ROADMAP.md'), '- [ ] **Phase 1: Foundation**\n- [ ] **Phase 2: Accounts**\n- [x] 01-03-PLAN.md');
    await writeFile(join(root, phase, '01-03-PLAN.md'), '---\nphase: 01-foundation\n---\n<tasks><task type="auto"><name>01-03-01 — Local mail</name><done>Local delivery verified</done><files>docs/mail.md</files></task><task type="checkpoint:human-action"><name>01-03-02 — Live sender</name><done>Verify sender</done></task></tasks>');
    await writeFile(join(root, phase, '01-03-SUMMARY.md'), '---\nstatus: halted\nmetrics: {tasks_completed: 1, tasks_total: 2}\ncheckpoint: {type: human-action, task: 01-03-02}\n---');
    await mkdir(join(root, 'docs'));
    await writeFile(join(root, 'docs/mail.md'), '# Mail\n\n- [x] Local\n');
    await writeFile(join(root, 'spec.pdf'), '%PDF-1.4\n');
    const content = await projectContent(root);
    assert.equal(content.documents.length, 2);
    assert.deepEqual(content.tasks.map(task => task.status), ['done', 'blocked', 'todo']);
    assert.ok(content.tasks[0].docs.includes('docs/mail.md'));
    assert.match(content.tasks[2].title, /Phase 2/);
    assert.equal((await readDocument(root, 'docs/mail.md')).bytes.toString(), '# Mail\n\n- [x] Local\n');
    assert.equal((await readDocument(root, 'spec.pdf')).type, 'application/pdf');
    await writeFile(join(root, phase, '01-03-SUMMARY.md'), '---\nstatus: complete\n---');
    assert.deepEqual((await projectContent(root)).tasks.slice(0, 2).map(task => task.status), ['done', 'done']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('document reader rejects traversal, symlink escapes and other file types', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'project-docs-'));
  const root = join(parent, 'project');
  try {
    await mkdir(root);
    await writeFile(join(parent, 'private.md'), 'private');
    await writeFile(join(root, '.env'), 'secret');
    await symlink(join(parent, 'private.md'), join(root, 'escape.md'));
    await assert.rejects(readDocument(root, '../private.md'), /outside/);
    await assert.rejects(readDocument(root, join(parent, 'private.md')), /outside/);
    await assert.rejects(readDocument(root, 'escape.md'), /outside/);
    await assert.rejects(readDocument(root, '.env'), /Markdown or PDF/);
    assert.equal((await projectContent(root)).documents.length, 0);
  } finally { await rm(parent, { recursive: true, force: true }); }
});


test('TROPHY summary takes priority over internal project documents', async () => {
  const root = await mkdtemp(join(tmpdir(), 'trophy-docs-'));
  try {
    await writeFile(join(root, 'TROPHY-SUMMARY.md'), '# Project summary');
    await writeFile(join(root, 'README.md'), '# Developer setup');
    const content = await projectContent(root);
    assert.deepEqual(content.documents.map(doc => doc.path), ['TROPHY-SUMMARY.md']);
  } finally { await rm(root, { recursive: true, force: true }); }
});
