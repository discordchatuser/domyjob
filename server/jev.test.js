import test from 'node:test';
import assert from 'node:assert/strict';
import { loadRoutingSkill } from './model-route.js';
import { selectWithJev } from './jev.js';
import { handleMcp } from './jev-mcp.js';
const skill = await loadRoutingSkill();
const available = [{ model: 'new-small', description: 'Simple edits' }, { model: 'new-standard', isDefault: true }, { model: 'new-deep', description: 'Complex reasoning' }];
const base = { task: 'Implement complex feature', available, skill, apiKey: 'test-secret' };
const answer = { answers: { model: { type: 'choice', choice: 'new-deep', confidence: .9 }, difficulty: { type: 'choice', choice: 'hard', confidence: .8 } }, usage: { cost: .0001 } };

test('JEV chooses from discovered values through the documented Decisions API', async () => {
  let request;
  const route = await selectWithJev({ ...base, fetchImpl: async (url, options) => { request = { url, ...options }; return Response.json(answer); } });
  assert.equal(request.url, 'https://openrouter.ai/api/alpha/decisions');
  assert.equal(request.headers.Authorization, 'Bearer test-secret');
  const body = JSON.parse(request.body);
  assert.deepEqual(Object.keys(body.questions.model.criteria), available.map(model => model.model));
  assert.equal(body.state.task, base.task);
  assert.equal(body.model, 'typesafe/jev-1.13');
  assert.equal(route.model, 'new-deep');
  assert.equal(route.source, 'jev');
  assert.equal(route.confidence, .9);
  assert.equal(route.decisionCost, .0001);
});

test('missing key, provider failure and invalid choices visibly fall back without leaking credentials', async () => {
  const missing = await selectWithJev({ ...base, apiKey: '', fetchImpl: () => { throw new Error('Must not call'); } });
  assert.equal(missing.model, 'new-standard');
  assert.match(missing.warning, /OPENROUTER_API_KEY/);
  for (const fetchImpl of [async () => Response.json({ error: 'test-secret' }, { status: 401 }), async () => { throw new Error('test-secret'); }, async () => Response.json({ answers: { ...answer.answers, model: { ...answer.answers.model, choice: 'not-discovered' } } }), async () => Response.json({ answers: { ...answer.answers, model: { ...answer.answers.model, confidence: 20 } } })]) {
    const route = await selectWithJev({ ...base, fetchImpl });
    assert.equal(route.model, 'new-standard');
    assert.equal(route.source, 'fallback');
    assert.ok(route.warning);
    assert.ok(!JSON.stringify(route).includes('test-secret'));
  }
});

test('explicit override avoids JEV and cancellation propagates instead of falling back', async () => {
  const route = await selectWithJev({ ...base, pinnedModel: 'new-small', fetchImpl: () => { throw new Error('Must not call'); } });
  assert.equal(route.model, 'new-small');
  assert.equal(route.source, 'override');
  const controller = new AbortController();
  await assert.rejects(selectWithJev({ ...base, signal: controller.signal, fetchImpl: async () => { controller.abort(); throw controller.signal.reason; } }), { name: 'AbortError' });
});

test('subagent model tool works over MCP without exposing secrets', async () => {
  const init = await handleMcp({ id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } });
  assert.equal(init.result.protocolVersion, '2024-11-05');
  const list = await handleMcp({ id: 2, method: 'tools/list' });
  assert.equal(list.result.tools[0].name, 'choose_model');
  const reply = await handleMcp({ id: 3, method: 'tools/call', params: { name: 'choose_model', arguments: { task: 'Implement worker task' } } }, async () => ({ model: 'new-small', source: 'jev', confidence: .8 }));
  assert.equal(JSON.parse(reply.result.content[0].text).model, 'new-small');
  const invalid = await handleMcp({ id: 4, method: 'tools/call', params: { name: 'choose_model', arguments: { task: '' } } }, () => { throw new Error('test-secret'); });
  assert.equal(invalid.result.isError, true);
  assert.ok(!JSON.stringify(invalid).includes('test-secret'));
  assert.equal(await handleMcp({ method: 'notifications/initialized' }), null);
});
