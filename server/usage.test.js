import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { usageStore, openRouterAccount } from './usage.js';
import { selectWithJev } from './jev.js';
test('usage persists across restarts and deduplicates cumulative Codex snapshots', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'usage-'));
  try {
    const store = usageStore(dir);
    await Promise.all([10, 25, 20].map(totalTokens => store.record({ id: 'codex:thread', provider: 'codex', tokens: { totalTokens } })));
    await store.record({ id: 'request-1', provider: 'openrouter', cost: .002 });
    const records = await usageStore(dir).records();
    assert.equal(records.length, 2);
    assert.equal(records.find(r => r.provider === 'codex').tokens.totalTokens, 25);
    assert.equal(records.find(r => r.provider === 'openrouter').cost, .002);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('account reporting whitelists numeric fields and never exposes key metadata', async () => {
  const result = await openRouterAccount(async () => ({ ok: true, json: async () => ({ data: { usage: 2, usage_daily: .1, limit_remaining: 4, label: 'secret-prefix', key: 'secret', usage_monthly: 'wrong' } }) }), 'key');
  assert.deepEqual(result, { available: true, usage: 2, usage_daily: .1, limit_remaining: 4 });
  assert.equal((await openRouterAccount(null, '')).available, false);
  assert.equal((await openRouterAccount(async () => { throw new Error('secret'); }, 'key')).available, false);
});
test('billed JEV responses are recorded even when the decision is invalid', async () => {
  const events = [];
  const result = await selectWithJev({ task: 'Fix thing', available: [{ model: 'test', isDefault: true }], skill: { models: { medium: 'test' } }, apiKey: 'secret', usageContext: { project: '/project' }, reportUsage: async event => events.push(event), fetchImpl: async () => ({ ok: true, json: async () => ({ id: 'generation-1', model: 'jev', usage: { cost: .001, input_tokens: 50, output_tokens: 5 } }) }) });
  assert.equal(result.source, 'fallback');
  assert.equal(events[0].cost, .001);
  assert.equal(events[0].project, '/project');
  assert.ok(!JSON.stringify(events).includes('secret'));
});
