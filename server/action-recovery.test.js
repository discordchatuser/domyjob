import test from 'node:test';
import assert from 'node:assert/strict';
import { actionFailure, actionResult, inspectActionWithJev } from './action-recovery.js';

const cache = { id: 'npm', type: 'command_execution', command: 'npm uninstall smtp-server', exit_code: 1, status: 'completed', aggregated_output: 'npm error EPERM mkdtemp /Users/user/.npm/_cacache/tmp/example' };
const response = (choice, confidence = .9) => Response.json({ answers: { next_step: { type: 'choice', choice, confidence } }, usage: { cost: .001 } });

test('detects nonzero exits even when tool status is completed, plus MCP failures', () => {
  assert.equal(actionFailure(cache).kind, 'permission');
  assert.equal(actionFailure({ ...cache, aggregated_output: 'ENOTCACHED only-if-cached' }).kind, 'missing-cache');
  assert.equal(actionFailure({ ...cache, exit_code: 0 }), null);
  assert.equal(actionFailure({ id: 'tool', type: 'activity', status: 'failed', output: 'requires approval' }).kind, 'permission');
});

test('JEV inspects failed status, output, constraints and history through Decisions API', async () => {
  let request;
  const usage = [];
  const decision = await inspectActionWithJev({ apiKey: 'secret', task: 'Replace Email', action: actionResult(cache), history: [], usageContext: { project: '/project' }, reportUsage: async item => usage.push(item), fetchImpl: async (url, options) => {
    request = { url, headers: options.headers, body: JSON.parse(options.body) };
    return response('writable_cache');
  } });
  assert.equal(request.url, 'https://openrouter.ai/api/alpha/decisions');
  assert.equal(request.body.model, 'typesafe/jev-1.13');
  assert.equal(request.body.state.action.exitCode, 1);
  assert.match(request.body.state.action.output, /mkdtemp/);
  assert.equal(request.body.state.permissions.networkAccess, false);
  assert.equal(decision.decision, 'retry');
  assert.equal(decision.source, 'jev');
  assert.equal(usage[0].project, '/project');
  assert.equal(usage[0].cost, .001);
});

test('missing offline packages stop rather than retrying offline; next successful action is inspectable', async () => {
  const history = [actionResult(cache)];
  const action = actionResult({ ...cache, command: 'npm uninstall --offline --cache .npm-cache', aggregated_output: 'ENOTCACHED package not cached' });
  const blocked = await inspectActionWithJev({ apiKey: 'secret', task: 'Change contact method', action, history, fetchImpl: async (_, options) => {
    assert.equal(JSON.parse(options.body).state.retry_history[0].kind, 'permission');
    return response('user_required');
  } });
  assert.equal(blocked.decision, 'stop');
  const success = await inspectActionWithJev({ apiKey: 'secret', task: 'Change contact method', action: actionResult({ ...cache, exit_code: 0, aggregated_output: 'Tests passed' }), history, fetchImpl: async (_, options) => {
    assert.equal(JSON.parse(options.body).state.action.exitCode, 0);
    return response('continue');
  } });
  assert.equal(success.decision, 'continue');
});

test('missing key, invalid or uncertain decisions and provider failures fail closed without leaking secrets', async () => {
  const base = { task: 'Task', action: actionResult(cache), apiKey: 'secret' };
  assert.equal((await inspectActionWithJev({ ...base, apiKey: '' })).decision, 'stop');
  for (const fetchImpl of [async () => response('invented'), async () => response('continue', .2), async () => Response.json({}, { status: 500 }), async () => { throw new Error('secret'); }]) {
    const decision = await inspectActionWithJev({ ...base, fetchImpl });
    assert.equal(decision.decision, 'stop');
    assert.ok(!JSON.stringify(decision).includes('secret'));
  }
});

test('cancellation propagates and does not start fallback work', async () => {
  const controller = new AbortController();
  await assert.rejects(inspectActionWithJev({ apiKey: 'secret', task: 'Task', action: actionResult(cache), signal: controller.signal, fetchImpl: async () => { controller.abort(); throw controller.signal.reason; } }), { name: 'AbortError' });
});
