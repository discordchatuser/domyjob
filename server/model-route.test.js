import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { loadRoutingSkill, chooseRoute } from './model-route.js';
import { createClient } from './codex.js';

const available = ['gpt-6-luna', 'gpt-6.1-sol', 'gpt-6-astra'].map(model => ({ model, isDefault: model === 'gpt-6.1-sol' }));
const assessment = (tier, requestedModel = null) => JSON.stringify({ tier, reason: 'Several connected decisions.', requestedModel });

test('uses the skill mappings, respects explicit models, and reports unavailable models', async () => {
  const skill = await loadRoutingSkill();
  for (const [tier, model] of Object.entries(skill.models)) assert.equal(chooseRoute(assessment(tier), skill, available).model, model);
  assert.equal(chooseRoute(assessment('easy', 'gpt-6-astra'), skill, available, 'gpt-6-luna').model, 'gpt-6-astra');
  assert.equal(chooseRoute(assessment('hard'), skill, available, 'gpt-6-luna').model, 'gpt-6-luna');
  const fallback = chooseRoute(assessment('hard'), skill, available.slice(0, 2));
  assert.equal(fallback.model, 'gpt-6.1-sol');
  assert.match(fallback.warning, /gpt-6-astra is unavailable/);
  assert.throws(() => chooseRoute('no JSON', skill, available), /valid JSON/);
  assert.throws(() => chooseRoute(assessment('unknown'), skill, available), /invalid route/);
});

class RoutingRpc extends EventEmitter {
  calls = [];
  tier = 'hard';
  malformed = false;
  holdAssessment = false;
  requestedModel = null;
  async request(method, params) {
    this.calls.push({ method, params });
    if (method === 'thread/start' || method === 'thread/resume') return { thread: { id: 'thread-1' }, model: params.model || 'gpt-6.1-sol' };
    if (method === 'model/list') return { data: available, nextCursor: null };
    if (method === 'turn/interrupt') {
      this.emit('notification', { method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: params.turnId, status: 'interrupted' } } });
      return {};
    }
    if (method === 'turn/start') {
      const routing = Boolean(params.outputSchema);
      const id = routing ? 'assessment' : 'execution';
      if (!(routing && this.holdAssessment)) queueMicrotask(() => {
        this.emit('notification', { method: 'item/completed', params: { threadId: 'thread-1', item: { type: 'agentMessage', id, phase: 'final', text: routing ? this.malformed ? 'bad JSON' : assessment(this.tier, this.requestedModel) : 'Work complete' } } });
        this.emit('notification', { method: 'turn/completed', params: { threadId: 'thread-1', turn: { id, status: 'completed' } } });
      });
      return { turn: { id } };
    }
    return {};
  }
  send() {}
  close() {}
}

for (const resumed of [false, true]) {
  test(`assesses before execution and switches models on ${resumed ? 'resumed' : 'new'} threads`, async () => {
    const rpc = new RoutingRpc();
    const client = createClient(rpc, { cwd: '/workspace' });
    const thread = resumed ? client.resume('thread-1') : client.start();
    const { events } = await thread.runStreamed('Design a complex system');
    const seen = [];
    for await (const event of events) seen.push(event);
    const turns = rpc.calls.filter(call => call.method === 'turn/start');
    assert.equal(turns.length, 2);
    assert.match(turns[0].params.input[0].text, /How difficult is this task/);
    assert.equal(turns[0].params.sandboxPolicy.type, 'readOnly');
    assert.ok(turns[0].params.outputSchema);
    assert.equal(turns[1].params.input[0].text, 'Design a complex system');
    assert.equal(turns[1].params.model, 'gpt-6-astra');
    const restore = rpc.calls.find(call => call.method === 'thread/resume' && call.params.model === 'gpt-6-astra');
    assert.equal(restore.params.sandbox, 'workspace-write');
    assert.match(restore.params.developerInstructions, /gpt-6-luna/);
    assert.ok(seen.find(event => event.type === 'model.routing'));
    assert.equal(seen.find(event => event.type === 'model.changed').route.tier, 'hard');
    assert.equal(seen.filter(event => event.type === 'item.completed').length, 1, 'assessment JSON should not leak into transcript');
    assert.equal(seen.find(event => event.type === 'item.completed').item.text, 'Work complete');
    assert.equal(rpc.listenerCount('notification'), 0);

    rpc.tier = 'easy';
    const next = await client.resume('thread-1').runStreamed('Fix a typo');
    const nextEvents = [];
    for await (const event of next.events) nextEvents.push(event);
    assert.equal(nextEvents.find(event => event.type === 'model.changed').route.model, 'gpt-6-luna');
    assert.equal(rpc.calls.filter(call => call.method === 'turn/start').length, 4, 'each user task gets a fresh assessment');
  });
}

test('invalid assessment prevents execution and removes listeners', async () => {
  const rpc = new RoutingRpc(); rpc.malformed = true;
  const { events } = await createClient(rpc).start().runStreamed('Task');
  await assert.rejects(async () => { for await (const event of events) {} }, /valid JSON/);
  assert.equal(rpc.calls.filter(call => call.method === 'turn/start').length, 1);
  assert.equal(rpc.listenerCount('notification'), 0);
});

test('cancellation interrupts the assessment and never starts execution', async () => {
  const rpc = new RoutingRpc(); rpc.holdAssessment = true;
  const controller = new AbortController();
  const { events } = await createClient(rpc).start().runStreamed('Task', { signal: controller.signal });
  const consume = (async () => { for await (const event of events) {} })();
  for (let i = 0; i < 50 && !rpc.calls.some(call => call.method === 'turn/start'); i++) await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  await consume;
  assert.ok(rpc.calls.some(call => call.method === 'turn/interrupt' && call.params.turnId === 'assessment'));
  assert.equal(rpc.calls.filter(call => call.method === 'turn/start').length, 1);
  assert.equal(rpc.listenerCount('notification'), 0);
});
