import test from 'node:test';
import assert from 'node:assert/strict';
import { appServerArgs } from './rpc.js';

test('app server explicitly preapproves only the app task and routing tools', () => {
  const args = appServerArgs();
  const config = new Map(args.flatMap((arg, index) => arg === '-c' ? [args[index + 1].split(/=(.*)/s).slice(0, 2)] : []));
  const approvals = [...config].filter(([key]) => key.endsWith('.approval_mode'));
  assert.deepEqual(approvals, [
    ['mcp_servers.jev_router.tools.choose_model.approval_mode', '"approve"'],
    ['mcp_servers.project_tasks.tools.list_tasks.approval_mode', '"approve"'],
    ['mcp_servers.project_tasks.tools.create_task.approval_mode', '"approve"'],
    ['mcp_servers.project_tasks.tools.update_task.approval_mode', '"approve"'],
  ]);
  assert.deepEqual(JSON.parse(config.get('mcp_servers.project_tasks.enabled_tools')), ['list_tasks', 'create_task', 'update_task']);
  assert.ok(![...config.keys()].some(key => key === 'approval_policy' || key === 'sandbox_mode' || key.endsWith('.default_tools_approval_mode')));
  assert.equal(config.get('mcp_servers.project_tasks.command'), JSON.stringify(process.execPath));
});
