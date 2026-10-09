import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';

// These app-owned tools are already authorized by the task and routing workflows.
// Keep approval overrides tool-specific; leave other MCP servers and shell policy alone.
export const appToolApprovals = {
  project_tasks: ['list_tasks', 'create_task', 'update_task'],
  jev_router: ['choose_model'],
};
export function appServerArgs() {
  const servers = {
    jev_router: [fileURLToPath(new URL('./jev-mcp.js', import.meta.url)), fileURLToPath(new URL('../.data/model-catalog.json', import.meta.url))],
    project_tasks: [fileURLToPath(new URL('./tasks-mcp.js', import.meta.url))],
  };
  return ['app-server', '--enable', 'multi_agent', ...Object.entries(servers).flatMap(([server, args]) => [
    '-c', `mcp_servers.${server}.command=${JSON.stringify(process.execPath)}`,
    '-c', `mcp_servers.${server}.args=${JSON.stringify(args)}`,
    '-c', `mcp_servers.${server}.enabled_tools=${JSON.stringify(appToolApprovals[server])}`,
    ...appToolApprovals[server].flatMap(tool => ['-c', `mcp_servers.${server}.tools.${tool}.approval_mode="approve"`]),
  ]), '--listen', 'stdio://'];
}

export class CodexRpc extends EventEmitter {
  constructor(binary) {
    super();
    this.pending = new Map(); this.nextId = 1; this.failure = null;
    this.child = spawn(binary, appServerArgs(), { stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    this.child.stderr.on('data', data => { stderr = (stderr + data).slice(-4000); });
    this.lines = createInterface({ input: this.child.stdout });
    this.lines.on('line', line => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      if (message.method && message.id != null) {
        if (['item/tool/requestUserInput', 'tool/requestUserInput', 'item/tool/call'].includes(message.method)) this.emit('serverRequest', message);
        else this.send({ id: message.id, error: { code: -32601, message: 'This interactive request is unsupported by this client' } });
      } else if (message.id != null) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id); clearTimeout(pending.timer);
        if (message.error) pending.reject(new Error(message.error.message)); else pending.resolve(message.result);
      } else if (message.method) this.emit('notification', message);
    });
    this.child.on('error', error => this.fail(error));
    this.child.stdin.on('error', error => this.fail(error));
    this.child.on('exit', (code, signal) => this.fail(new Error(`Codex app-server exited (${signal || code}). ${stderr}`)));
  }
  fail(error) {
    if (this.failure) return;
    this.failure = error;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear(); this.emit('failure', error);
  }
  send(message) {
    if (this.failure) throw this.failure;
    this.child.stdin.write(JSON.stringify(message) + '\n');
  }
  request(method, params) {
    if (this.failure) return Promise.reject(this.failure);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id); reject(new Error(`Codex request timed out: ${method}`));
      }, 30000);
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ id, method, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  close() { this.lines.close(); this.child.kill(); this.fail(new Error('Codex app-server closed')); }
}
