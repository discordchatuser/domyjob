import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { browseFolders, projectInfo, projectServers } from './projects.js';

async function until(check) {
  for (let i = 0; i < 100; i++) {
    const value = await check();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('Timed out waiting for process');
}

test('browses outside the app and detects Laravel and Node server commands', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'projects-'));
  try {
    await mkdir(join(cwd, 'TROPHY')); await mkdir(join(cwd, 'node_modules'));
    await writeFile(join(cwd, 'TROPHY', 'composer.json'), JSON.stringify({ scripts: { dev: ['@php artisan dev'] } }));
    await writeFile(join(cwd, 'TROPHY', 'package.json'), JSON.stringify({ scripts: { dev: 'vite' } }));
    const listing = await browseFolders(cwd);
    assert.deepEqual(listing.folders.map(item => item.name), ['TROPHY']);
    assert.equal((await projectInfo(listing.folders[0].path)).command, 'composer dev');
    await writeFile(join(cwd, 'package.json'), JSON.stringify({ scripts: { start: 'node index.js' } }));
    assert.equal((await projectInfo(cwd)).command, 'npm start');
    await assert.rejects(projectInfo(join(cwd, 'missing')));
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('captures both output streams, rejects duplicate starts, stops and restarts servers', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'project-server-'));
  const servers = projectServers();
  try {
    await writeFile(join(cwd, 'serve.cjs'), "console.log(process.cwd()); console.error('stderr ready'); console.log('\\x1b[31mred\\x1b[0m'); console.log('color=' + process.env.FORCE_COLOR); setInterval(() => {}, 1000);");
    const command = `"${process.execPath}" serve.cjs`;
    assert.equal((await servers.start(cwd, command)).status, 'running');
    await assert.rejects(servers.start(cwd, command), /already running/);
    const live = await until(async () => { const next = await servers.get(cwd); return next.output.includes('stderr ready') && next; });
    assert.ok(live.output.includes(cwd));
    assert.ok(live.output.includes('\x1b[31mred\x1b[0m'));
    assert.match(live.output, /color=1/);
    assert.ok(live.runId);
    assert.equal(live.outputEnd, live.output.length);
    assert.equal((await servers.stop(cwd)).status, 'stopped');
    await servers.start(cwd, 'definitely-no-such-project-command');
    const failed = await until(async () => { const next = await servers.get(cwd); return next.status === 'stopped' && next; });
    assert.notEqual(failed.exitCode, 0);
    assert.match(failed.output, /not found|not recognized/);
    await servers.start(cwd, command);
    await servers.close();
    assert.equal((await servers.get(cwd)).status, 'stopped');
  } finally { await servers.close(); await rm(cwd, { recursive: true, force: true }); }
});
