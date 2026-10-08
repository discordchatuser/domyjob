import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { loadRoutingSkill } from './model-route.js';
import { modelCatalog } from './model-catalog.js';
import { createClient } from './codex.js';

const available = ['gpt-6-luna', 'gpt-6.1-sol', 'gpt-6-astra'].map(model => ({ model, isDefault: model === 'gpt-6.1-sol' }));
class RoutingRpc extends EventEmitter {
  calls = [];
  async request(method, params) {
    this.calls.push({ method, params });
    if (method === 'thread/start' || method === 'thread/resume') return { thread: { id: 'thread-1' } };
    if (method === 'model/list') return { data: available, nextCursor: null };
    if (method === 'turn/start') {
      queueMicrotask(() => {
        this.emit('notification', { method: 'item/completed', params: { threadId: 'thread-1', item: { type: 'agentMessage', id: 'execution', phase: 'final', text: 'Work complete' } } });
        this.emit('notification', { method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'execution', status: 'completed' } } });
      });
      return { turn: { id: 'execution' } };
    }
    return {};
  }
  send() {}
  close() {}
}

test('catalog is discovered once with pagination and shared by concurrent consumers', async () => {
  const calls = [];
  const catalog = modelCatalog({ async request(method, params) { calls.push(params); return params.cursor ? { data: [available[1], available[2]], nextCursor: null } : { data: [available[0], available[1]], nextCursor: 'page2' }; } });
  const [first, second] = await Promise.all([catalog(), catalog()]);
  assert.equal(first, second);
  assert.equal(first.length, 3);
  await catalog();
  assert.equal(calls.length, 2);
  assert.equal(calls[1].cursor, 'page2');
  const broken = modelCatalog({ request: async () => ({ data: [], nextCursor: null }) });
  await assert.rejects(broken(), /did not advertise/);
});

for (const resumed of [false, true]) {
  test(`JEV selection precedes execution on ${resumed ? 'resumed' : 'new'} threads without an inference preflight`, async () => {
    const rpc = new RoutingRpc();
    const decisions = [];
    const selectModel = async input => { decisions.push(input); return { tier: input.task.includes('typo') ? 'easy' : 'hard', model: input.task.includes('typo') ? available[0].model : available[2].model, source: 'jev', confidence: .88, reason: 'JEV model selection.' }; };
    const client = createClient(rpc, { cwd: '/workspace', selectModel });
    await client.getModels();
    const thread = resumed ? client.resume('thread-1') : client.start();
    const { events } = await thread.runStreamed('Design a complex system', { orchestrator: true, context: 'Recent project context' });
    const seen = [];
    for await (const event of events) seen.push(event);
    assert.equal(rpc.calls.filter(call => call.method === 'turn/start').length, 1);
    const start = rpc.calls.find(call => call.method === (resumed ? 'thread/resume' : 'thread/start'));
    assert.equal(start.params.model, 'gpt-6-astra');
    assert.match(start.params.developerInstructions, /jev_router MCP choose_model/);
    assert.match(start.params.developerInstructions, /gpt-6-luna/);
    assert.equal(decisions[0].context, 'Recent project context');
    assert.equal(seen.find(event => event.type === 'model.changed').route.confidence, .88);
    const next = await client.resume('thread-1').runStreamed('Fix a typo');
    for await (const event of next.events) {}
    assert.equal(decisions.length, 2);
    assert.equal(rpc.calls.filter(call => call.method === 'model/list').length, 1);
    assert.equal(rpc.calls.filter(call => call.method === 'turn/start').length, 2);
    assert.equal(rpc.listenerCount('notification'), 0);
  });
}

test('cancellation during JEV routing never starts an execution turn', async () => {
  const rpc = new RoutingRpc();
  const controller = new AbortController();
  const client = createClient(rpc, { selectModel: async () => { controller.abort(); return { model: available[0].model }; } });
  const { events } = await client.start().runStreamed('Task', { signal: controller.signal });
  for await (const event of events) {}
  assert.equal(rpc.calls.some(call => call.method === 'turn/start'), false);
  assert.equal(rpc.listenerCount('notification'), 0);
});

test('routing policy remains editable without rediscovering model availability', async () => {
  const skill = await loadRoutingSkill();
  assert.deepEqual(Object.keys(skill.models), ['easy', 'medium', 'hard']);
});
