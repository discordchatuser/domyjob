import { randomUUID } from 'node:crypto';
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { resolve, dirname, basename } from 'node:path';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';

export async function projectInfo(path) {
  const cwd = await realpath(resolve(path || process.env.CODEX_WORKDIR || process.cwd()));
  if (!(await stat(cwd)).isDirectory()) throw new Error('Select an existing folder');
  const load = async name => { try { return JSON.parse(await readFile(resolve(cwd, name), 'utf8')); } catch { return {}; } };
  const [composer, pkg] = await Promise.all([load('composer.json'), load('package.json')]);
  const command = composer.scripts?.dev ? 'composer dev' : pkg.scripts?.dev ? 'npm run dev' : pkg.scripts?.start ? 'npm start' : '';
  return { cwd, name: basename(cwd), command };
}

export async function browseFolders(path) {
  const project = await projectInfo(path?.startsWith('~/') ? resolve(homedir(), path.slice(2)) : path);
  const entries = await readdir(project.cwd, { withFileTypes: true });
  const folders = (await Promise.all(entries.filter(entry => !entry.name.startsWith('.') && entry.name !== 'node_modules' && entry.name !== 'vendor').map(async entry => {
    const path = resolve(project.cwd, entry.name);
    try { if (entry.isDirectory() || (entry.isSymbolicLink() && (await stat(path)).isDirectory())) return { name: entry.name, path }; } catch {}
    return null;
  }))).filter(Boolean).sort((a, b) => a.name.localeCompare(b.name));
  return { ...project, parent: dirname(project.cwd), folders };
}

export function projectServers() {
  const records = new Map();
  const snapshot = record => record ? { cwd: record.cwd, command: record.command, status: record.status, output: record.output, exitCode: record.exitCode, runId: record.runId, outputEnd: record.outputEnd } : { status: 'stopped', output: '' };
  function kill(child, signal) {
    try { if (process.platform === 'win32') child.kill(signal); else process.kill(-child.pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
  async function stopRecord(record) {
    if (!record || !['running', 'stopping'].includes(record.status)) return;
    record.status = 'stopping';
    kill(record.child, 'SIGTERM');
    const timer = setTimeout(() => kill(record.child, 'SIGKILL'), 3000);
    try { await record.done; } finally { clearTimeout(timer); }
  }
  return {
    async get(path) { return snapshot(records.get((await projectInfo(path)).cwd)); },
    async start(path, command) {
      const project = await projectInfo(path);
      if (['running', 'stopping'].includes(records.get(project.cwd)?.status)) throw new Error('Project server is already running');
      command = command === undefined ? project.command : command;
      if (typeof command !== 'string' || !command.trim() || command.length > 4096) throw new Error('Enter a server command');
      const child = spawn(command, { cwd: project.cwd, shell: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, FORCE_COLOR: '1', TERM: 'xterm-256color', COLORTERM: 'truecolor' } });
      const record = { cwd: project.cwd, command, child, status: 'running', output: '', outputEnd: 0, runId: randomUUID(), exitCode: null };
      const append = chunk => { record.outputEnd += chunk.length; record.output = (record.output + chunk).slice(-200000); };
      child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
      child.stdout.on('data', append); child.stderr.on('data', append);
      record.done = new Promise(done => {
        child.on('error', error => append(error.message + '\n'));
        child.on('close', (code, signal) => { record.exitCode = code; record.status = 'stopped'; append(`\n[Process exited: ${signal || code}]\n`); done(); });
      });
      records.set(project.cwd, record);
      return snapshot(record);
    },
    async stop(path) { const cwd = (await projectInfo(path)).cwd; await stopRecord(records.get(cwd)); return snapshot(records.get(cwd)); },
    async close() { await Promise.all([...records.values()].map(stopRecord)); },
  };
}
