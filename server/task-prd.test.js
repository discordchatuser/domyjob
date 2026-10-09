import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, symlink, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { syncTaskPrd } from './task-prd.js';
import { assessmentCandidates } from './task-assessment.js';

test('PRD requests preserve original requirements, update idempotently and remove deleted requests', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'task-prd-'));
  const task = { id: 'replace-email', title: 'Replace Email', description: 'Remove Email and add SMS', status: 'todo', assessment: { impact: 'replace' } };
  try {
    await writeFile(join(cwd, 'PRD.md'), '# Product\n\n## Notifications\nOffer Email.\n');
    await syncTaskPrd(cwd, 'PRD.md', [task]);
    await syncTaskPrd(cwd, 'PRD.md', [{ ...task, description: 'Remove Email and add Push' }]);
    let prd = await readFile(join(cwd, 'PRD.md'), 'utf8');
    assert.match(prd, /Offer Email/);
    assert.match(prd, /Remove Email and add Push/);
    assert.doesNotMatch(prd, /add SMS/);
    assert.equal(prd.match(/Task ID:/g).length, 1);
    await syncTaskPrd(cwd, 'PRD.md', []);
    prd = await readFile(join(cwd, 'PRD.md'), 'utf8');
    assert.doesNotMatch(prd, /Task ID:/);
    assert.match(prd, /Offer Email/);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('PRD sync rejects symlink escapes', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'prd-escape-'));
  try {
    const cwd = join(parent, 'project'); await mkdir(cwd);
    await writeFile(join(parent, 'private.md'), '# Private');
    await symlink(join(parent, 'private.md'), join(cwd, 'PRD.md'));
    await assert.rejects(syncTaskPrd(cwd, 'PRD.md', []), /outside/);
  } finally { await rm(parent, { recursive: true, force: true }); }
});

test('relationship candidates prioritize matching functionality and exclude the current task', () => {
  const task = { id: 'new', title: 'Replace Email option', description: 'Use SMS' };
  const result = assessmentCandidates(task, [task, { id: 'email', title: 'Add Email option' }, ...Array.from({ length: 30 }, (_, index) => ({ id: String(index), title: 'Unrelated work' }))]);
  assert.equal(result.length, 24);
  assert.equal(result[0].id, 'email');
  assert.ok(!result.some(item => item.id === 'new'));
});
