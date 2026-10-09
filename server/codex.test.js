import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createClient } from './codex.js';

class FakeRpc extends EventEmitter {
  calls = [];
  async request(method, params) {
    this.calls.push({ method, params });
    if (method === 'thread/start' || method === 'thread/resume') return { thread: { id: 'thread-1' } };
    if (method === 'turn/start') {
      queueMicrotask(() => {
        this.emit('notification', { method: 'item/started', params: { threadId: 'thread-1', item: { type: 'agentMessage', id: 'a', text: '' } } });
        this.emit('notification', { method: 'item/agentMessage/delta', params: { threadId: 'thread-1', itemId: 'a', delta: 'Hello' } });
      });
      return { turn: { id: 'turn-1' } };
    }
    if (method === 'turn/interrupt') this.emit('notification', { method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'interrupted' } } });
    return {};
  }
  close() {}
}

test('adapts streamed messages and interrupts before cleaning and deleting', async () => {
  const rpc = new FakeRpc();
  const client = createClient(rpc, { cwd: '/workspace', routing: false });
  const controller = new AbortController();
  const { events } = await client.start().runStreamed('Hello', { signal: controller.signal, orchestrator: true });
  const seen = [];
  for await (const event of events) {
    seen.push(event);
    if (event.type === 'item.updated') controller.abort();
  }
  assert.equal(seen[0].thread_id, 'thread-1');
  assert.match(rpc.calls[0].params.developerInstructions, /persistent main orchestrator/);
  assert.match(rpc.calls[0].params.developerInstructions, /spawn and manage subagents/);
  assert.match(rpc.calls[0].params.developerInstructions, /project_tasks/);
  assert.match(rpc.calls[0].params.developerInstructions, /current project's absolute path/);
  assert.match(rpc.calls[0].params.developerInstructions, /\"\/workspace\"/);
  assert.equal(seen.find(event => event.type === 'item.updated').item.text, 'Hello');
  await client.deleteThread('thread-1');
  assert.deepEqual(rpc.calls.map(call => call.method), ['thread/start', 'turn/start', 'turn/interrupt', 'thread/backgroundTerminals/clean', 'thread/delete']);
  assert.equal(rpc.listenerCount('notification'), 0);
});

test('cleanup failure prevents deletion of the Codex thread', async () => {
  const rpc = new FakeRpc();
  const request = rpc.request.bind(rpc);
  rpc.request = async (method, params) => {
    if (method === 'thread/backgroundTerminals/clean') throw new Error('Cleanup unsupported');
    return request(method, params);
  };
  const client = createClient(rpc, { routing: false });
  await assert.rejects(client.deleteThread('thread-1'), /Cleanup unsupported/);
  assert.equal(rpc.calls.some(call => call.method === 'thread/delete'), false);
});

for (const dynamic of [false, true]) {
 for (const resumed of [false, true]) {
  test(`answers ${dynamic ? 'dynamic ask_user' : 'native user input'} questions on ${resumed ? 'resumed' : 'new'} threads and resumes the same turn`, async () => {
    const rpc = new FakeRpc();
    const sent = [];
    rpc.send = message => {
      sent.push(message);
      queueMicrotask(() => rpc.emit('notification', { method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } } }));
    };
    const questions = [{ id: 'storage', header: 'Storage', question: 'How should todos be saved?', options: [{ label: 'Browser', description: 'Use local storage' }, { label: 'Backend', description: 'Use a server' }] }];
    const baseRequest = rpc.request.bind(rpc);
    rpc.request = async (method, params) => {
      if (method === 'turn/start') {
        rpc.calls.push({ method, params });
        queueMicrotask(() => rpc.emit('serverRequest', {
          id: 77,
          method: dynamic ? 'item/tool/call' : 'item/tool/requestUserInput',
          params: { threadId: 'thread-1', turnId: 'turn-1', ...(dynamic ? { tool: 'ask_user', arguments: { questions } } : { questions }) },
        }));
        return { turn: { id: 'turn-1' } };
      }
      return baseRequest(method, params);
    };
    const client = createClient(rpc, { cwd: '/workspace', routing: false });
    const thread = resumed ? client.resume('thread-1', '/another/folder') : client.start('/another/folder');
    const { events } = await thread.runStreamed('Build a todo app');
    let requestId;
    for await (const event of events) {
      if (event.type !== 'questions') continue;
      requestId = event.request.requestId;
      assert.deepEqual(event.request.questions, questions);
      assert.throws(() => client.answerQuestion('other-thread', requestId, {}), /no longer/);
      assert.throws(() => client.answerQuestion('thread-1', requestId, {}), /every question/);
      client.answerQuestion('thread-1', requestId, { storage: { answers: ['Backend'] } });
    }
    assert.equal(rpc.calls[0].params.cwd, '/another/folder');
    assert.equal(rpc.calls[0].method, resumed ? 'thread/resume' : 'thread/start');
    assert.match(rpc.calls[0].params.developerInstructions, /retrying failed questions/);
    assert.match(rpc.calls[0].params.developerInstructions, /ask_user works in Default mode/);
    if (!resumed) assert.equal(rpc.calls[0].params.dynamicTools[0].name, 'ask_user');
    assert.equal(sent[0].id, 77);
    const result = dynamic ? JSON.parse(sent[0].result.contentItems[0].text) : sent[0].result;
    assert.deepEqual(result, { answers: { storage: { answers: ['Backend'] } } });
    assert.throws(() => client.answerQuestion('thread-1', requestId, {}), /no longer/);
    assert.equal(rpc.listenerCount('serverRequest'), 0);
  });
 }
}

test('adapts generated, viewed and MCP images', async () => {
  const rpc = new FakeRpc();
  const original = rpc.request.bind(rpc);
  rpc.request = async (method, params) => {
    if (method !== 'turn/start') return original(method, params);
    queueMicrotask(() => {
      for (const item of [
        { type: 'imageGeneration', id: 'generated', result: 'base64-image', savedPath: null, status: 'completed' },
        { type: 'imageView', id: 'viewed', path: '/tmp/image.png' },
        { type: 'mcpToolCall', id: 'mcp', tool: 'draw', result: { content: [{ type: 'image', data: 'mcp-base64' }] } },
      ]) rpc.emit('notification', { method: 'item/completed', params: { threadId: 'thread-1', item } });
      rpc.emit('notification', { method: 'turn/completed', params: { threadId: 'thread-1', turn: { status: 'completed' } } });
    });
    return { turn: { id: 'turn-1' } };
  };
  const client = createClient(rpc, { routing: false });
  const { events } = await client.start().runStreamed('Create an image');
  const seen = []; for await (const event of events) if (event.item) seen.push(event.item);
  assert.equal(seen[0].base64, 'base64-image');
  assert.equal(seen[1].source, '/tmp/image.png');
  assert.equal(seen[2].references[0].base64, 'mcp-base64');
});

test('orchestrator exposes subagent spawn and result activity in the transcript', async () => {
  const rpc = new FakeRpc();
  const baseRequest = rpc.request.bind(rpc);
  rpc.request = async (method, params) => {
    if (method !== 'turn/start') return baseRequest(method, params);
    rpc.calls.push({ method, params });
    queueMicrotask(() => {
      for (const [id, tool, agentsStates] of [['spawn', 'spawnAgent', { worker: { status: 'running' } }], ['wait', 'wait', { worker: { status: 'completed', message: 'Tests pass' } }]]) {
        rpc.emit('notification', { method: 'item/completed', params: { threadId: 'thread-1', item: { id, type: 'collabAgentToolCall', tool, prompt: 'Implement bounded task', receiverThreadIds: ['worker'], agentsStates, status: 'completed' } } });
      }
      rpc.emit('notification', { method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } } });
    });
    return { turn: { id: 'turn-1' } };
  };
  const client = createClient(rpc, { routing: false });
  const { events } = await client.start('/project').runStreamed('Implement feature', { orchestrator: true });
  const activities = [];
  for await (const event of events) if (event.item?.type === 'activity') activities.push(event.item);
  assert.equal(activities[0].label, 'Spawned subagent');
  assert.match(activities[1].output, /worker: completed\nTests pass/);
  assert.equal(rpc.listenerCount('notification'), 0);
});

test('records parent and observed child usage with project attribution', async () => {
  const rpc = new FakeRpc(), records = [];
  const original = rpc.request.bind(rpc);
  rpc.request = async (method, params) => {
    if (method !== 'turn/start') return original(method, params);
    queueMicrotask(() => {
      const emit = (method, params) => rpc.emit('notification', { method, params });
      emit('item/started', { threadId: 'thread-1', item: { id: 'spawn', type: 'collabAgentToolCall', tool: 'spawnAgent', receiverThreadIds: ['child'], model: 'small', status: 'inProgress' } });
      for (const threadId of ['thread-1', 'child', 'unrelated']) emit('thread/tokenUsage/updated', { threadId, tokenUsage: { total: { totalTokens: 50, inputTokens: 40, cachedInputTokens: 10, outputTokens: 10, reasoningOutputTokens: 3 } } });
      emit('turn/completed', { threadId: 'thread-1', turn: { status: 'completed' } });
    });
    return { turn: { id: 'turn' } };
  };
  const client = createClient(rpc, { routing: false, usage: { record: async event => records.push(event) } });
  const { events } = await client.start().runStreamed('Build feature', { usageProject: '/project' });
  for await (const event of events) { /* consume */ }
  assert.equal(records.length, 2);
  assert.equal(records[1].id, 'codex:child');
  assert.equal(records[1].model, 'small');
  assert.equal(records[0].project, '/project');
  assert.equal(records[0].tokens.totalTokens, 50);
});


test('resumed orchestrators receive the current task capture skill and project scope', async () => {
  const rpc = new FakeRpc();
  const client = createClient(rpc, { routing: false });
  const controller = new AbortController();
  const { events } = await client.resume('thread-1', '/current-project').runStreamed('Create a task', { orchestrator: true, signal: controller.signal });
  for await (const event of events) if (event.type === 'item.updated') controller.abort();
  assert.equal(rpc.calls[0].method, 'thread/resume');
  assert.match(rpc.calls[0].params.developerInstructions, /project_tasks/);
  assert.match(rpc.calls[0].params.developerInstructions, /"\/current-project"/);
  assert.match(rpc.calls[0].params.developerInstructions, /Creation schedules work/);
});

class RecoveryRpc extends FakeRpc {
  turns = 0;
  interrupted = new Set();
  constructor(results) { super(); this.results = results; }
  async request(method, params) {
    if (method === 'turn/interrupt') {
      this.calls.push({ method, params });
      this.interrupted.add(params.turnId);
      this.emit('notification', { method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: params.turnId, status: 'interrupted' } } });
      return {};
    }
    if (method !== 'turn/start') return super.request(method, params);
    this.calls.push({ method, params });
    const id = 'turn-' + ++this.turns;
    queueMicrotask(() => {
      this.emit('notification', { method: 'turn/started', params: { threadId: 'thread-1', turn: { id } } });
      const item = this.results[this.turns - 1] || { type: 'agentMessage', text: 'Verified outcome' };
      this.emit('notification', { method: 'item/completed', params: { threadId: 'thread-1', item: { id: 'action-' + this.turns, ...item } } });
      if (!this.interrupted.has(id)) this.emit('notification', { method: 'turn/completed', params: { threadId: 'thread-1', turn: { id, status: 'completed' } } });
    });
    return { turn: { id } };
  }
}
const failedNpm = { type: 'commandExecution', command: 'npm uninstall smtp-server', exitCode: 1, aggregatedOutput: 'EPERM mkdtemp ~/.npm', status: 'completed' };

test('pauses failures for JEV, checks the next successful action, then continues in the same thread', async () => {
  const rpc = new RecoveryRpc([failedNpm, { ...failedNpm, command: 'npm --cache .npm-cache uninstall smtp-server', exitCode: 0, aggregatedOutput: 'Removed package' }]);
  const inspections = [];
  const client = createClient(rpc, { routing: false, inspectAction: async input => {
    inspections.push(input);
    assert.equal(rpc.calls.at(-1).method, 'turn/interrupt', 'turn is paused before JEV decides');
    return { decision: inspections.length === 1 ? 'retry' : 'continue', source: 'jev', reason: 'Use writable cache' };
  } });
  const { events } = await client.start('/project').runStreamed('Remove SMTP and verify', { inputImages: ['data:image/png;base64,test'] });
  const seen = []; for await (const event of events) seen.push(event);
  assert.equal(inspections.length, 2);
  assert.equal(inspections[0].action.exitCode, 1);
  assert.equal(inspections[1].action.exitCode, 0);
  assert.equal(inspections[1].history[0].decision.decision, 'retry');
  assert.equal(seen.filter(event => event.type === 'recovery.decision').length, 2);
  assert.equal(rpc.turns, 3);
  assert.equal(rpc.calls.filter(call => call.method === 'thread/start').length, 1);
  const turns = rpc.calls.filter(call => call.method === 'turn/start');
  assert.match(turns[1].params.input[0].text, /JEV inspected/);
  assert.equal(turns[0].params.input.length, 2);
  assert.equal(turns[1].params.input.length, 1);
  assert.equal(rpc.listenerCount('notification'), 0);
});

test('offline cache miss stops with JEV reason and never launches another action', async () => {
  const rpc = new RecoveryRpc([{ ...failedNpm, aggregatedOutput: 'ENOTCACHED only-if-cached' }]);
  const client = createClient(rpc, { routing: false, inspectAction: async () => ({ decision: 'stop', source: 'jev', reason: 'Dependencies are unavailable without network access.' }) });
  const { events } = await client.start().runStreamed('Remove SMTP');
  await assert.rejects(async () => { for await (const event of events) { /* consume */ } }, /Dependencies are unavailable/);
  assert.equal(rpc.turns, 1);
  assert.equal(rpc.listenerCount('notification'), 0);
});

test('bounded retries stop even if JEV keeps recommending another retry', async () => {
  const rpc = new RecoveryRpc([failedNpm, failedNpm, failedNpm, failedNpm]);
  const client = createClient(rpc, { routing: false, inspectAction: async () => ({ decision: 'retry', source: 'jev', reason: 'Try a fix' }) });
  const { events } = await client.start().runStreamed('Remove SMTP');
  await assert.rejects(async () => { for await (const event of events) { /* consume */ } }, /recovery limit/);
  assert.equal(rpc.turns, 3);
});

test('cancelling while JEV checks prevents a recovery turn', async () => {
  const rpc = new RecoveryRpc([failedNpm]);
  const controller = new AbortController();
  const client = createClient(rpc, { routing: false, inspectAction: async () => { controller.abort(); return { decision: 'retry', reason: 'Try again' }; } });
  const { events } = await client.start().runStreamed('Remove SMTP', { signal: controller.signal });
  for await (const event of events) { /* consume */ }
  assert.equal(rpc.turns, 1);
  assert.equal(rpc.listenerCount('notification'), 0);
});
