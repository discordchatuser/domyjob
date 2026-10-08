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
  const client = createClient(rpc, { cwd: '/workspace' });
  const controller = new AbortController();
  const { events } = await client.start().runStreamed('Hello', { signal: controller.signal });
  const seen = [];
  for await (const event of events) {
    seen.push(event);
    if (event.type === 'item.updated') controller.abort();
  }
  assert.equal(seen[0].thread_id, 'thread-1');
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
  const client = createClient(rpc);
  await assert.rejects(client.deleteThread('thread-1'), /Cleanup unsupported/);
  assert.equal(rpc.calls.some(call => call.method === 'thread/delete'), false);
});

for (const dynamic of [false, true]) {
  test(`answers ${dynamic ? 'dynamic ask_user' : 'native user input'} questions and resumes the same turn`, async () => {
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
    const client = createClient(rpc, { cwd: '/workspace' });
    const { events } = await client.start('/another/folder').runStreamed('Build a todo app');
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
    assert.equal(rpc.calls[0].params.dynamicTools[0].name, 'ask_user');
    assert.equal(sent[0].id, 77);
    const result = dynamic ? JSON.parse(sent[0].result.contentItems[0].text) : sent[0].result;
    assert.deepEqual(result, { answers: { storage: { answers: ['Backend'] } } });
    assert.throws(() => client.answerQuestion('thread-1', requestId, {}), /no longer/);
    assert.equal(rpc.listenerCount('serverRequest'), 0);
  });
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
  const client = createClient(rpc);
  const { events } = await client.start().runStreamed('Create an image');
  const seen = []; for await (const event of events) if (event.item) seen.push(event.item);
  assert.equal(seen[0].base64, 'base64-image');
  assert.equal(seen[1].source, '/tmp/image.png');
  assert.equal(seen[2].references[0].base64, 'mcp-base64');
});
