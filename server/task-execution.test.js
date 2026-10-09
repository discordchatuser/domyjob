import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from './app.js';
import { handleTaskMcp } from './tasks-mcp.js';

test('task execution uses the project orchestrator and audits routing and completion', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'task-run-'));
  let received, evaluationCount = 0, failRun = false;
  const server = await createApp({ dataDir: dir, selectTaskModel: async ({ task }) => (evaluationCount++, { model: 'test-model', source: 'jev', assessment: { impact: 'update', confidence: .9, needsClarification: task.includes('something different'), relationships: [] } }), getCodex: async () => ({ getModels: async () => [{ model: 'test-model' }], start: cwd => ({ runStreamed: async (prompt, options) => {
    received = { cwd, prompt, options };
    return { events: (async function* () {
      yield { type: 'model.changed', route: { model: 'test-model', source: 'jev' } };
      if (failRun) {
        const action = { id: 'npm', action: 'npm uninstall --offline', exitCode: 1, kind: 'missing-cache', output: 'ENOTCACHED' };
        yield { type: 'recovery.checking', action };
        yield { type: 'recovery.decision', action, decision: { decision: 'stop', source: 'jev', reason: 'Required dependency is unavailable offline.' } };
        throw new Error('Task stopped: Required dependency is unavailable offline.');
      }
      yield { type: 'item.completed', item: { type: 'agent_message', text: 'Verified' } };
    })() };
  } }) }) });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try {
    const task = await (await post('/api/project/tasks', { cwd: dir, title: 'Implement accounts', description: 'Verify login', highlights: [{ start: 0, end: 6 }], images: [{ name: 'reference.png', data: 'data:image/png;base64,iVBORw0KGgo=', marks: [{ x: .1, y: .2, width: .3, height: .4 }] }] })).json();
    const chat = await (await post('/api/chats', { cwd: dir })).json();
    const response = await post(`/api/chats/${chat.id}/messages`, { prompt: task.title, taskId: task.id });
    assert.equal(response.status, 200); await response.text();
    assert.equal(received.options.orchestrator, true);
    assert.equal(received.options.requestedModel, undefined);
    assert.equal(received.options.preparedRoute.model, 'test-model');
    assert.match(received.prompt, /Verify login/);
    assert.match(received.prompt, /Highlighted text: \["Verify"\]/);
    assert.equal(received.options.inputImages[0], 'data:image/png;base64,iVBORw0KGgo=');
    const content = await (await fetch(base + '/api/project/content?path=' + encodeURIComponent(dir))).json();
    assert.equal(content.tasks[0].status, 'done');
    assert.deepEqual(content.audit.map(entry => entry.action), ['execution.completed', 'execution.model_selected', 'execution.running', 'task.assessed', 'task.assessed', 'task.created']);
    assert.equal(content.tasks[0].executions[0].outcome, 'Verified');
    assert.equal(content.tasks[0].assessment.prdSync, 'synced');
    const prd = await (await fetch(base + '/api/project/document?path=' + encodeURIComponent(dir) + '&file=PRD.md')).text();
    assert.match(prd, /Requested impact: update/);
    assert.equal(content.audit[1].route.source, 'jev');
    const move = await fetch(base + '/api/project/tasks', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cwd: dir, id: task.id, status: 'todo' }) });
    assert.equal(move.status, 200);
    assert.equal((await move.json()).status, 'todo');
    assert.equal(evaluationCount, 1);
    const unclear = await (await post('/api/project/tasks', { cwd: dir, title: 'Replace Email', description: 'Use something different' })).json();
    assert.equal(unclear.assessment.needsClarification, true);
    const clarify = await post(`/api/chats/${chat.id}/messages`, { prompt: unclear.title, taskId: unclear.id });
    assert.equal(clarify.status, 200); await clarify.text();
    assert.match(received.prompt, /CLARIFICATION REQUIRED/);
    assert.match(received.prompt, /Before making any changes/);
    assert.match(received.prompt, /use ask_user/);
    assert.match(received.prompt, /Wait for the answers/);
    const toolCall = (name, args) => handleTaskMcp({ id: 1, method: 'tools/call', params: { name, arguments: { project: dir, ...args } } }, { baseUrl: base });
    const captured = await toolCall('create_task', { title: 'Add Push notifications', description: 'Offer Push in settings. Done when a test notification arrives.' });
    assert.equal(captured.result.isError, undefined);
    const saved = JSON.parse(captured.result.content[0].text).task;
    assert.equal(saved.status, 'todo');
    assert.equal(saved.assessment.status, 'evaluated');
    assert.equal(saved.assessment.prdSync, 'synced');
    const listed = JSON.parse((await toolCall('list_tasks', {})).result.content[0].text);
    assert.ok(listed.tasks.some(item => item.id === saved.id));
    const updated = await toolCall('update_task', { id: saved.id, description: 'Offer Push in settings. Done when delivery and opt-out are verified.' });
    assert.equal(JSON.parse(updated.result.content[0].text).task.assessment.status, 'evaluated');
    const latest = await (await fetch(base + '/api/project/content?path=' + encodeURIComponent(dir))).json();
    assert.ok(latest.audit.some(entry => entry.taskId === saved.id && entry.action === 'task.created'));
    assert.match(await (await fetch(base + '/api/project/document?path=' + encodeURIComponent(dir) + '&file=PRD.md')).text(), /delivery and opt-out/);
    failRun = true;
    const stopped = await post(`/api/chats/${chat.id}/messages`, { prompt: saved.title, taskId: saved.id });
    const streamed = (await stopped.text()).trim().split('\n').map(line => JSON.parse(line));
    assert.ok(streamed.some(event => event.type === 'activity' && event.item.label === 'JEV: stop'));
    assert.ok(streamed.some(event => event.type === 'error' && event.error.includes('unavailable offline')));
    const blockedContent = await (await fetch(base + '/api/project/content?path=' + encodeURIComponent(dir))).json();
    const blocked = blockedContent.tasks.find(item => item.id === saved.id);
    assert.equal(blocked.status, 'blocked');
    assert.equal(blocked.execution.status, 'failed');
    const recovery = blockedContent.audit.find(entry => entry.action === 'execution.recovery_decision');
    assert.equal(recovery.decision.source, 'jev');
    assert.equal(recovery.actionResult.exitCode, 1);
    assert.equal(recovery.actionResult.kind, 'missing-cache');

  } finally { await new Promise(resolve => server.close(resolve)); await rm(dir, { recursive: true, force: true }); }
});
