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
