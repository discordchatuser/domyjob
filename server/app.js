import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile, mkdir, rename, writeFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';

export async function createApp({ getCodex, dataDir = '.data', distDir = 'dist' }) {
  await mkdir(dataDir, { recursive: true });
  const file = resolve(dataDir, 'chats.json');
  let chats;
  try { chats = JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; chats = []; }
  const running = new Map();
  const deleting = new Set();
  let saves = Promise.resolve();
  function save() {
    const snapshot = JSON.stringify(chats, null, 2);
    saves = saves.catch(() => {}).then(async () => {
      await writeFile(`${file}.tmp`, snapshot);
      await rename(`${file}.tmp`, file);
    });
    return saves;
  }
  const summary = chat => ({ ...chat, busy: running.has(chat.id) });
  return createServer(async (req, res) => {
    const json = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    try {
      const pathname = new URL(req.url, 'http://localhost').pathname;
      if (req.method !== 'GET') {
        const origin = req.headers.origin;
        if (origin && !['http://127.0.0.1:5173', 'http://localhost:5173', 'http://127.0.0.1:3001', 'http://localhost:3001'].includes(origin)) return json(403, { error: 'Origin not allowed' });
      }
      if (req.method === 'GET' && pathname === '/api/status') {
        try { const codex = await getCodex(); return json(200, { ready: true, binary: codex.binary, model: codex.model }); }
        catch (error) { return json(200, { ready: false, error: error.message }); }
      }
      if (req.method === 'GET' && pathname === '/api/chats') return json(200, chats.map(summary));
      if (req.method === 'POST' && pathname === '/api/chats') {
        const chat = { id: randomUUID(), threadId: null, title: 'New thread', messages: [] };
        chats.unshift(chat); await save(); return json(201, summary(chat));
      }
      const deletion = pathname.match(/^\/api\/chats\/([^/]+)$/);
      if (req.method === 'DELETE' && deletion) {
        const index = chats.findIndex(chat => chat.id === deletion[1]);
        if (index < 0) return json(404, { error: 'Thread not found' });
        const chat = chats[index];
        if (deleting.has(chat.id)) return json(409, { error: 'Thread deletion is already in progress' });
        deleting.add(chat.id);
        try {
          const active = running.get(chat.id);
          active?.abort();
          if (active) await active.settled;
          if (chat.threadId) await (await getCodex()).deleteThread(chat.threadId);
          running.delete(chat.id);
          chats = chats.filter(item => item.id !== chat.id); await save();
          return json(200, { deleted: true });
        } finally { deleting.delete(chat.id); }
      }
      const match = pathname.match(/^\/api\/chats\/([^/]+)\/messages$/);
      if (req.method === 'POST' && match) {
        const chat = chats.find(chat => chat.id === match[1]);
        if (!chat) return json(404, { error: 'Thread not found' });
        if (deleting.has(chat.id)) return json(409, { error: 'Thread is being deleted' });
        if (running.has(chat.id)) return json(409, { error: 'This thread is already running' });
        const controller = new AbortController();
        let settle;
        controller.settled = new Promise(resolve => { settle = resolve; });
        running.set(chat.id, controller);
        try {
          let body = '';
          for await (const chunk of req) {
            body += chunk;
            if (Buffer.byteLength(body) > 65536) return json(413, { error: 'Prompt is too large' });
          }
          let input;
          try { input = JSON.parse(body); } catch { return json(400, { error: 'Invalid JSON' }); }
          if (typeof input.prompt !== 'string' || (input.commands !== undefined && (!Array.isArray(input.commands) || input.commands.length > 10 || input.commands.some(command => typeof command !== 'string' || !command.trim())))) return json(400, { error: 'Invalid prompt or commands' });
          const commands = (input.commands || []).map(command => command.trim());
          if (!input.prompt.trim() && !commands.length) return json(400, { error: 'Enter a prompt or command' });
          const codexPrompt = commands.length
            ? 'Run these shell commands in the working directory and report their output and exit status. For a long-running server, report startup output and return rather than waiting indefinitely.\n' + commands.map(command => JSON.stringify(command)).join('\n') + (input.prompt.trim() ? '\n\nUser request:\n' + input.prompt.trim() : '')
            : input.prompt.trim();
          const codex = await getCodex();
          const thread = chat.threadId ? codex.resume(chat.threadId) : codex.start();
          chat.messages.push({ role: 'user', text: input.prompt.trim(), ...(commands.length ? { commands } : {}) });
          if (chat.title === 'New thread') chat.title = (input.prompt.trim() || commands[0]).slice(0, 48);
          await save();
          res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-cache' });
          const send = event => { if (!res.destroyed) res.write(JSON.stringify(event) + '\n'); };
          res.on('close', () => { if (!res.writableEnded) controller.abort(); });
          if (controller.signal.aborted) { res.end(); return; }
          send({ type: 'chat', chat: summary(chat) });
          try {
            const { events } = await thread.runStreamed(codexPrompt, { signal: controller.signal });
            for await (const event of events) {
              if (event.type === 'thread.started') { chat.threadId = event.thread_id; await save(); }
              if (['item.started', 'item.updated', 'item.completed'].includes(event.type) && event.item.type === 'agent_message') send({ type: 'message', id: event.item.id, text: event.item.text });
              if (['item.started', 'item.updated', 'item.completed'].includes(event.type) && event.item.type === 'command_execution') {
                send({ type: 'command', id: event.item.id, command: event.item.command, output: event.item.aggregated_output, exitCode: event.item.exit_code });
                if (event.type === 'item.completed') chat.messages.push({ role: 'assistant', text: '$ ' + event.item.command + '\n' + (event.item.aggregated_output || '') + (event.item.exit_code == null ? '' : '\nExit code: ' + event.item.exit_code) });
              }
              if (event.type === 'item.completed' && event.item.type === 'agent_message') chat.messages.push({ role: 'assistant', text: event.item.text });
              if (event.type === 'turn.failed') throw new Error(event.error.message);
              if (event.type === 'error') throw new Error(event.message);
            }
          } catch (error) {
            chat.messages.push({ role: 'error', text: error.message });
            send({ type: 'error', error: error.message });
          }
          await save(); running.delete(chat.id);
          send({ type: 'done', chat: summary(chat) }); res.end();
        } finally { running.delete(chat.id); settle(); }
        return;
      }
      if (pathname.startsWith('/api/')) return json(404, { error: 'Not found' });
      if (req.method !== 'GET') return json(405, { error: 'Method not allowed' });
      const root = resolve(distDir);
      let path = resolve(root, '.' + decodeURIComponent(pathname));
      if (!path.startsWith(root + '/') && path !== root) return json(403, { error: 'Forbidden' });
      let content;
      try { content = await readFile(path); } catch { path = resolve(root, 'index.html'); content = await readFile(path); }
      const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
      res.writeHead(200, { 'Content-Type': types[extname(path)] || 'application/octet-stream' }); res.end(content);
    } catch (error) {
      if (res.headersSent) res.end(JSON.stringify({ type: 'error', error: error.message }) + '\n');
      else json(500, { error: error.code === 'ENOENT' ? 'Run npm run dev, or npm run build first.' : error.message });
    }
  });
}
