import { usageStore, openRouterAccount } from './usage.js';
import { migrateProjectChats, projectOrchestrator } from './project-chats.js';
import { projectContent, readDocument } from './project-content.js';
import { browseFolders, projectInfo, projectServers } from './projects.js';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile, mkdir, rename, writeFile, stat, realpath } from 'node:fs/promises';
import { imageStore, imageReferences } from './images.js';
import { resolve, extname } from 'node:path';

export async function createApp({ getCodex, dataDir = '.data', distDir = 'dist' }) {
  await mkdir(dataDir, { recursive: true });
  const images = imageStore(dataDir);
  const usage = usageStore(dataDir);
  let accountCache;
  let accountAt = 0;
  const file = resolve(dataDir, 'chats.json');
  let chats;
  try { chats = JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; chats = []; }
  const servers = projectServers();
  const running = new Map();
  const deleting = new Set();
  const questions = new Map();
  async function readJson(req) {
    let body = '';
    for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > 65536) throw new Error('Request is too large'); }
    return body ? JSON.parse(body) : {};
  }
  let saves = Promise.resolve();
  function save() {
    const snapshot = JSON.stringify(chats, null, 2);
    saves = saves.catch(() => {}).then(async () => {
      await writeFile(`${file}.tmp`, snapshot);
      await rename(`${file}.tmp`, file);
    });
    return saves;
  }
  let canonicalized = false;
  for (const chat of chats) {
    if (!chat.cwd) continue;
    try { const cwd = await realpath(chat.cwd); if (cwd !== chat.cwd) { chat.cwd = cwd; canonicalized = true; } } catch {}
  }
  if (migrateProjectChats(chats) || canonicalized) await save();
  const summary = chat => ({ ...chat, busy: running.has(chat.id), pendingQuestions: questions.get(chat.id) || [] });
  const server = createServer(async (req, res) => {
    const json = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    try {
      const pathname = new URL(req.url, 'http://localhost').pathname;
      if (req.method !== 'GET') {
        const origin = req.headers.origin;
        if (origin && !['http://127.0.0.1:5173', 'http://localhost:5173', 'http://127.0.0.1:3001', 'http://localhost:3001'].includes(origin)) return json(403, { error: 'Origin not allowed' });
      }
      if (pathname === '/api/folders' && req.method === 'GET') {
        try { return json(200, await browseFolders(new URL(req.url, 'http://localhost').searchParams.get('path'))); }
        catch (error) { return json(400, { error: error.message }); }
      }
      if (req.method === 'GET' && ['/api/project/content', '/api/project/document'].includes(pathname)) {
        try {
          const params = new URL(req.url, 'http://localhost').searchParams;
          if (pathname.endsWith('/content')) return json(200, await projectContent(params.get('path')));
          const document = await readDocument(params.get('path'), params.get('file'));
          res.writeHead(200, { 'Content-Type': document.type, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' });
          res.end(document.bytes); return;
        } catch (error) { return json(400, { error: error.message }); }
      }
      if (pathname === '/api/project' && req.method === 'GET') {
        try { return json(200, await projectInfo(new URL(req.url, 'http://localhost').searchParams.get('path'))); }
        catch (error) { return json(400, { error: error.message }); }
      }
      if (pathname === '/api/project/server') {
        try {
          if (req.method === 'GET') return json(200, await servers.get(new URL(req.url, 'http://localhost').searchParams.get('path')));
          const input = await readJson(req);
          if (typeof input.cwd !== 'string' || !input.cwd.trim()) return json(400, { error: 'Select a project folder' });
          if (req.method === 'POST') return json(200, await servers.start(input.cwd, input.command));
          if (req.method === 'DELETE') return json(200, await servers.stop(input.cwd));
        } catch (error) { return json(400, { error: error.message }); }
      }
      if (req.method === 'GET' && pathname === '/api/usage') {
        res.setHeader('Cache-Control', 'no-store');
        if (!accountCache || Date.now() - accountAt > 60000) {
          accountCache = Promise.all([openRouterAccount(), getCodex().then(c => c.getAccountUsage?.()).catch(() => null)]).then(([openrouter, codex]) => ({ openrouter, codex }));
          accountAt = Date.now();
        }
        return json(200, { records: await usage.records(), accounts: await accountCache });
      }
      if (req.method === 'GET' && pathname === '/api/status') {
        try { const codex = await getCodex(); return json(200, { ready: true, binary: codex.binary, model: codex.model, models: codex.getModels ? (await codex.getModels()).map(item => ({ model: item.model, displayName: item.displayName || item.model })) : [], routingConfigured: codex.routingConfigured || false }); }
        catch (error) { return json(200, { ready: false, error: error.message }); }
      }
      if (req.method === 'GET' && pathname === '/api/chats') return json(200, chats.map(summary));
      if (req.method === 'POST' && pathname === '/api/chats') {
        let input;
        try { input = await readJson(req); } catch { return json(400, { error: 'Invalid request' }); }
        if (input.cwd !== undefined && typeof input.cwd !== 'string') return json(400, { error: 'Invalid working directory' });
        let cwd = input.cwd?.trim() ? resolve(input.cwd.trim()) : undefined;
        if (cwd) { try { if (!(await stat(cwd)).isDirectory()) throw new Error(); cwd = await realpath(cwd); } catch { return json(400, { error: 'Working directory must be an existing folder' }); } }
        if (cwd) { const existing = projectOrchestrator(chats, cwd); if (existing) return json(200, summary(existing)); }
        const chat = { id: randomUUID(), threadId: null, title: 'New thread', messages: [], ...(cwd ? { cwd, orchestrator: true, archivedProjectThread: false } : {}) };
        chats.unshift(chat); await save(); return json(201, summary(chat));
      }
      const imageRoute = pathname.match(/^\/api\/chats\/([^/]+)\/images\/([a-f0-9]{64}\.(?:png|jpg|gif|webp))$/);
      if (req.method === 'GET' && imageRoute) {
        const chat = chats.find(chat => chat.id === imageRoute[1]);
        if (!chat) return json(404, { error: 'Thread not found' });
        const image = chat.images?.find(image => image.id === imageRoute[2]);
        if (!image) return json(404, { error: 'Image not found' });
        let bytes;
        try { bytes = await images.read(chat, image.id); } catch { return json(404, { error: 'Image not found' }); }
        res.writeHead(200, { 'Content-Type': 'image/' + (image.type === 'jpg' ? 'jpeg' : image.type), 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' }); res.end(bytes); return;
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
          await images.remove(chat.id);
          running.delete(chat.id);
          chats = chats.filter(item => item.id !== chat.id); await save();
          return json(200, { deleted: true });
        } finally { deleting.delete(chat.id); }
      }
      const answer = pathname.match(/^\/api\/chats\/([^/]+)\/questions\/([^/]+)$/);
      if (req.method === 'POST' && answer) {
        const chat = chats.find(chat => chat.id === answer[1]);
        if (!chat) return json(404, { error: 'Thread not found' });
        if (!running.has(chat.id) || deleting.has(chat.id)) return json(409, { error: 'Thread is not waiting for an answer' });
        const request = (questions.get(chat.id) || []).find(item => item.requestId === answer[2]);
        if (!request) return json(409, { error: 'Question is no longer active' });
        let input;
        try {
          input = await readJson(req);
          (await getCodex()).answerQuestion(chat.threadId, request.requestId, input.answers);
        } catch (error) { return json(400, { error: error.message }); }
        const safeAnswers = Object.fromEntries(request.questions.map(q => [q.id, { answers: q.isSecret ? ['[Private answer]'] : input.answers[q.id].answers }]));
        const message = { role: 'user', text: request.questions.map(q => q.question + '\n' + safeAnswers[q.id].answers.join(', ')).join('\n\n'), questionResponse: { requestId: request.requestId, questions: request.questions, answers: safeAnswers } };
        chat.messages.push(message);
        questions.set(chat.id, (questions.get(chat.id) || []).filter(item => item.requestId !== request.requestId));
        running.get(chat.id)?.send?.({ type: 'questions.resolved', requestId: request.requestId });
        await save(); return json(200, { answered: true, message });
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
          if (input.model !== undefined && typeof input.model !== 'string') return json(400, { error: 'Invalid model' });
          const codex = await getCodex();
          if (input.model && codex.getModels && !(await codex.getModels()).some(item => item.model === input.model)) return json(400, { error: 'Model is not in the startup catalog' });
          const context = chat.messages.filter(message => ['user', 'assistant'].includes(message.role)).slice(-8).map(message => message.role + ': ' + (message.text || '')).join('\n').slice(-12000);
          const thread = chat.threadId ? codex.resume(chat.threadId, chat.cwd) : codex.start(chat.cwd);
          chat.messages.push({ role: 'user', text: input.prompt.trim(), ...(commands.length ? { commands } : {}) });
          if (chat.title === 'New thread') chat.title = (input.prompt.trim() || commands[0]).slice(0, 48);
          await save();
          res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-cache' });
          const send = event => { if (!res.destroyed) res.write(JSON.stringify(event) + '\n'); };
          controller.send = send;
          res.on('close', () => { if (!res.writableEnded) controller.abort(); });
          if (controller.signal.aborted) { res.end(); return; }
          send({ type: 'chat', chat: summary(chat) });
          try {
            const { events } = await thread.runStreamed(codexPrompt, { signal: controller.signal, orchestrator: Boolean(chat.orchestrator), context, requestedModel: input.model || undefined, usageProject: chat.cwd || '' });
            for await (const event of events) {
              if (event.type === 'model.routing') {
                chat.routing = true; send(event);
              }
              if (event.type === 'model.changed') {
                const previousModel = chat.model || null;
                chat.model = event.route.model; chat.modelRoute = event.route; chat.routing = false;
                const message = { role: 'model', modelRoute: { ...event.route, previousModel } };
                chat.messages.push(message);
                await save(); send({ ...event, previousModel, message });
              }
              if (event.type === 'questions') {
                questions.set(chat.id, [...(questions.get(chat.id) || []), event.request]);
                send(event);
              }
              if (event.type === 'questions.resolved') {
                questions.set(chat.id, (questions.get(chat.id) || []).filter(item => item.requestId !== event.requestId));
                send(event);
              }
              if (event.type === 'thread.started') { chat.threadId = event.thread_id; await save(); }
              if (['item.started', 'item.updated', 'item.completed'].includes(event.type) && event.item.type === 'agent_message') send({ type: 'message', id: event.item.id, text: event.item.text, phase: event.item.phase });
              if (['item.started', 'item.updated', 'item.completed'].includes(event.type) && event.item.type === 'command_execution') {
                send({ type: 'command', id: event.item.id, command: event.item.command, output: event.item.aggregated_output, exitCode: event.item.exit_code, status: event.item.status, durationMs: event.item.duration_ms });
                if (event.type === 'item.completed') chat.messages.push({ role: 'tool', id: event.item.id, command: event.item.command, output: event.item.aggregated_output || '', exitCode: event.item.exit_code, status: event.item.status || 'completed', durationMs: event.item.duration_ms });
              }
              if (['item.started', 'item.updated', 'item.completed'].includes(event.type) && event.item.type === 'activity') {
                send({ type: 'activity', item: event.item });
                if (event.type === 'item.completed') chat.messages.push({ ...event.item, role: 'activity' });
              }
              if (event.type === 'item.completed' && ['agent_message', 'image'].includes(event.item.type)) {
                const message = { role: 'assistant', text: event.item.text || '', phase: event.item.phase };
                const references = event.item.type === 'image' ? (event.item.references || [event.item]) : imageReferences(event.item.text);
                message.images = []; message.imageErrors = [];
                for (const reference of references.slice(0, 20)) {
                  try {
                    if (!reference.source && !reference.base64) continue;
                    const image = await images.capture(chat, reference, chat.cwd || codex.cwd);
                    if (!message.images.some(item => item.id === image.id)) message.images.push(image);
                    send({ type: 'image', image });
                  } catch (error) { message.imageErrors.push('Could not save image: ' + error.message); }
                }
                chat.messages.push(message);
              }
              if (event.type === 'turn.failed') throw new Error(event.error.message);
              if (event.type === 'error') throw new Error(event.message);
            }
          } catch (error) {
            chat.messages.push({ role: 'error', text: error.message });
            send({ type: 'error', error: error.message });
          }
          chat.routing = false;
          questions.delete(chat.id);
          await save(); running.delete(chat.id);
          send({ type: 'done', chat: summary(chat) }); res.end();
        } finally { questions.delete(chat.id); running.delete(chat.id); settle(); }
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
  server.closeProjects = () => servers.close();
  server.on('close', () => { servers.close().catch(console.error); });
  return server;
}
