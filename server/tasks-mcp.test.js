import test from 'node:test';
import assert from 'node:assert/strict';
import { handleTaskMcp } from './tasks-mcp.js';
const call = (name, args) => ({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
const decode = response => JSON.parse(response.result.content[0].text);

test('task tools route chat creation and definition updates to the existing application API', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, ...options });
    return Response.json({ id: 'task-1', title: 'Replace Email with SMS', description: 'Use SMS; verify delivery.', status: 'todo', assessment: { impact: 'replace', status: 'evaluated', prdSync: 'synced' } });
  };
  const created = decode(await handleTaskMcp(call('create_task', { project: '/project', title: 'Replace Email with SMS', description: 'Use SMS; verify delivery.' }), { fetchImpl }));
  assert.equal(created.saved, true);
  assert.equal(created.task.id, 'task-1');
  assert.equal(created.task.assessment.impact, 'replace');
  assert.equal(calls[0].url, 'http://127.0.0.1:3001/api/project/tasks');
  assert.equal(calls[0].method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].body), { cwd: '/project', title: 'Replace Email with SMS', description: 'Use SMS; verify delivery.' });
  await handleTaskMcp(call('update_task', { project: '/project', id: 'task-1', description: 'Use Push instead.' }), { fetchImpl });
  assert.equal(calls[1].method, 'PATCH');
  assert.equal(JSON.parse(calls[1].body).id, 'task-1');
});

test('listing uses project scope and omits image data and execution report payloads', async () => {
  let url;
  const reply = await handleTaskMcp(call('list_tasks', { project: '/a project' }), { fetchImpl: async value => { url = value; return Response.json({ cwd: '/a project', tasks: [{ id: '1', title: 'Task', status: 'todo', images: [{ data: 'large-image-data' }], execution: { status: 'completed', outcome: 'long report' } }] }); } });
  assert.equal(url, 'http://127.0.0.1:3001/api/project/content?path=%2Fa%20project');
  assert.equal(decode(reply).tasks[0].images, undefined);
  assert.equal(decode(reply).tasks[0].execution.outcome, undefined);
});

test('invalid calls cannot bypass task evaluation or write directly to arbitrary destinations', async () => {
  const fetchImpl = () => { throw new Error('Must not call'); };
  for (const message of [call('create_task', { project: '/project', title: '', description: '' }), call('create_task', { project: '/project', title: 'Task', description: 'Work', assessment: {} }), call('create_task', { project: 'relative', title: 'Task', description: '' }), call('update_task', { project: '/project', id: '1' }), call('delete_task', { project: '/project', id: '1' })]) {
    const reply = await handleTaskMcp(message, { fetchImpl }); assert.equal(reply.result.isError, true);
  }
});

test('connection failures warn about uncertain writes and do not retry automatically', async () => {
  let requests = 0;
  const reply = await handleTaskMcp(call('create_task', { project: '/project', title: 'Task', description: 'Work' }), { fetchImpl: async () => { requests++; throw new Error('secret connection details'); } });
  assert.equal(requests, 1);
  assert.equal(reply.result.isError, true);
  assert.match(reply.result.content[0].text, /List tasks before retrying/);
  assert.doesNotMatch(reply.result.content[0].text, /secret/);
});
