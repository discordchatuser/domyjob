import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { taskStore } from './project-tasks.js';

test('task edits, deletions and execution audit persist and stay isolated by project', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tasks-'));
  try {
    let store = await taskStore(dir);
    const imported = [{ id: 'plan:1', title: 'Imported', status: 'todo', docs: [] }];
    let task = await store.update('/a', imported, 'plan:1', { title: 'Edited' });
    assert.equal(store.merged('/a', imported)[0].title, 'Edited');
    task = await store.execution('/a', task, 'running', { chatId: 'chat' });
    await assert.rejects(store.update('/a', imported, task.id, {}, true), /running/);
    store = await taskStore(dir);
    assert.equal(store.merged('/a', imported)[0].execution.status, 'interrupted');
    await store.update('/a', imported, task.id, {}, true);
    assert.equal(store.merged('/a', imported).length, 0);
    assert.equal(store.audit('/b').length, 0);
    assert.deepEqual(store.audit('/a').map(item => item.action), ['task.deleted', 'execution.interrupted', 'execution.running', 'task.updated']);
    await assert.rejects(store.update('/a', [], null, { title: 'Invalid', images: [{ name: 'bad', data: 'data:image/png;base64,YmFk' }] }), /Unsupported/);
    await assert.rejects(store.update('/a', [], null, { title: 'Invalid', description: 'text', highlights: [{ start: 0, end: 10 }] }), /highlights/);
    const created = await store.update('/a', [], null, { title: 'New task', description: 'Do it' });
    assert.equal(store.merged('/a', [])[0].id, created.id);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
