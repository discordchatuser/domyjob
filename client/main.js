import { activityFromMessage, outputPreview } from './activity.js';
import { questionCard } from './questions.js';
import './style.css';
const $ = selector => document.querySelector(selector);
let chats = [], selected = null, status = {}, inFlight = new Set();
const drafts = new Map();
let commandMode = false, commands = [];
function saveDraft() {
  if (selected) drafts.set(selected, { text: $('#prompt').value, commands: [...commands], commandMode });
}
function composer() {
  $('#composer').classList.toggle('command-mode', commandMode);
  $('#prompt').placeholder = commandMode ? 'npm run dev' : 'Ask Codex anything…';
  $('#mode').textContent = commandMode ? 'Command · Esc to add' : 'Cmd+. to add a command';
  $('#commands').replaceChildren(...commands.map((command, index) => {
    const chip = document.createElement('button'); chip.type = 'button'; chip.className = 'command-chip';
    chip.textContent = '$ ' + command + ' ×'; chip.title = 'Remove command';
    chip.onclick = () => { commands.splice(index, 1); composer(); };
    return chip;
  }));
}
function finishCommand() {
  if (commandMode && $('#prompt').value.trim()) commands.push($('#prompt').value.trim());
  if (commandMode) $('#prompt').value = '';
  commandMode = false; composer();
}
const streams = new Map();
const expanded = new Set();
let lastRenderedThread;
async function api(path, options) {
  const response = await fetch('/api' + path, options);
  if (!response.ok) throw new Error((await response.json()).error || 'Request failed');
  return response.json();
}
function error(message = '') { $('#error').textContent = message; }
function render() {
  const chat = chats.find(chat => chat.id === selected);
  $('#title').textContent = chat?.title || 'New conversation';
  $('#threads').replaceChildren(...chats.map(chat => {
    const button = document.createElement('button');
    button.textContent = chat.title;
    button.className = chat.id === selected ? 'active' : '';
    button.onclick = () => {
      saveDraft();
      selected = chat.id; const draft = drafts.get(selected); $('#prompt').value = draft?.text || ''; commands = [...(draft?.commands || [])]; commandMode = draft?.commandMode || false; composer(); error(); render();
    };
    const row = document.createElement('div'); row.className = 'thread-row';
    const remove = document.createElement('button'); remove.className = 'delete-thread'; remove.textContent = '×';
    remove.title = 'Delete thread'; remove.setAttribute('aria-label', 'Delete ' + chat.title);

    remove.onclick = async () => {
      try {
        await api('/chats/' + chat.id, { method: 'DELETE' });
        chats = chats.filter(item => item.id !== chat.id); drafts.delete(chat.id); streams.delete(chat.id); inFlight.delete(chat.id);
        if (selected === chat.id) {
          selected = chats[0]?.id || null;
          const draft = drafts.get(selected); $('#prompt').value = draft?.text || '';
          commands = [...(draft?.commands || [])]; commandMode = draft?.commandMode || false; composer();
        }
        error(); render();
      } catch (e) { error(e.message); }
    };
    row.append(button, remove); return row;
  }));
  const messages = $('#messages');
  const follow = lastRenderedThread !== selected || messages.scrollHeight - messages.scrollTop - messages.clientHeight < 80;
  const scrollTop = messages.scrollTop;
  const focused = messages.contains(document.activeElement) ? document.activeElement.id : null;
  messages.replaceChildren();
  const items = [...(chat?.messages || [])];
  for (const item of streams.get(selected)?.values() || []) items.push(item);
  if (!items.length) {
    const empty = document.createElement('div'); empty.className = 'empty';
    const heading = document.createElement('h1'); heading.textContent = '› What are we working on?';
    const text = document.createElement('p'); text.textContent = 'Start a thread and send a prompt to your local Codex.';
    empty.append(heading, text); messages.append(empty);
  }
  for (const item of items) {
    const activity = activityFromMessage(item);
    if (activity) {
      const key = selected + ':' + (activity.id || items.indexOf(item));
      const details = document.createElement('details'); details.className = 'activity'; details.open = expanded.has(key);
      details.ontoggle = () => { if (!details.isConnected) return; if (details.open) expanded.add(key); else expanded.delete(key); };
      const summary = document.createElement('summary');
      const command = document.createElement('span'); command.className = 'activity-command'; command.textContent = activity.command || activity.label;
      command.title = command.textContent;
      const meta = document.createElement('span'); meta.className = 'activity-status';
      const failed = activity.exitCode != null && activity.exitCode !== 0 || activity.status === 'failed';
      if (failed) details.classList.add('failed');
      meta.textContent = failed ? 'exit ' + (activity.exitCode ?? 'failed') : activity.status === 'inProgress' || activity.status === 'running' ? 'running' : activity.exitCode != null ? 'exit ' + activity.exitCode : activity.status || 'done';
      if (activity.durationMs != null) meta.textContent += ' · ' + (activity.durationMs / 1000).toFixed(1) + 's';
      summary.append(command, meta); details.append(summary);
      const output = document.createElement('pre'); output.className = 'activity-output'; output.textContent = activity.output || '(no output)'; details.append(output);
      messages.append(details);
      const preview = outputPreview(activity.output);
      if (preview.text) { const text = document.createElement('pre'); text.className = 'activity-preview'; text.textContent = preview.text + (preview.more ? '\n… expand to see full output' : ''); messages.append(text); }
      continue;
    }
    const article = document.createElement('article'); article.className = item.role + (item.phase === 'commentary' ? ' commentary' : '');
    const label = document.createElement('span'); label.className = 'label'; label.textContent = { user: '›', assistant: '•', error: '!' }[item.role];
    const text = document.createElement('div'); text.className = 'text'; text.textContent = item.text;
    for (const command of item.commands || []) { const code = document.createElement('pre'); code.className = 'command-chip'; code.textContent = '$ ' + command; text.append(code); }
    article.append(label, text); messages.append(article);
  }
  for (const request of chat?.pendingQuestions || []) {
    messages.append(questionCard(request, async answers => {
      await api(`/chats/${chat.id}/questions/${request.requestId}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ answers }) });
      chat.pendingQuestions = (chat.pendingQuestions || []).filter(item => item.requestId !== request.requestId); render();
    }));
  }
  if (inFlight.has(selected) && !chat?.pendingQuestions?.length) { const waiting = document.createElement('div'); waiting.className = 'waiting'; waiting.textContent = 'Codex is working…'; messages.append(waiting); }
  messages.scrollTop = follow ? messages.scrollHeight : scrollTop;
  lastRenderedThread = selected;
  if (focused) document.getElementById(focused)?.focus({ preventScroll: true });
  $('#send').disabled = !status.ready || inFlight.has(selected) || chat?.busy;
  $('#title').title = chat?.cwd || 'Default working directory';
}
async function newChat() {
  const chat = await api('/chats', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cwd: $('#workspace').value.trim() }) });
  saveDraft();
  chats.unshift(chat); selected = chat.id; $('#prompt').value = ''; commands = []; commandMode = false; composer(); render(); return chat;
}
$('#new').onclick = () => newChat().catch(e => error(e.message));
$('#composer').onsubmit = async event => {
  event.preventDefault();
  if (!status.ready || inFlight.has(selected) || chats.find(chat => chat.id === selected)?.busy) return;
  if (commandMode) finishCommand();
  const prompt = $('#prompt').value.trim();
  const submittedCommands = [...commands];
  if (!prompt && !submittedCommands.length) return;
  let id;
  try {
    const chat = chats.find(chat => chat.id === selected) || await newChat();
    id = chat.id; inFlight.add(id); streams.set(id, new Map());
    $('#prompt').value = ''; commands = []; composer(); drafts.delete(id); error();
    chat.messages.push({ role: 'user', text: prompt, commands: submittedCommands }); render();
    const response = await fetch(`/api/chats/${id}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt, commands: submittedCommands }) });
    if (!response.ok) throw new Error((await response.json()).error);
    const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = ''; let doneReceived = false;
    const handle = line => {
      if (!line.trim()) return;
      const event = JSON.parse(line);
      if (!chats.some(chat => chat.id === id)) return;
      if (event.type === 'chat' || event.type === 'done') chats = chats.map(chat => chat.id === id ? event.chat : chat);
      const current = chats.find(chat => chat.id === id);
      if (event.type === 'questions') current.pendingQuestions = [...(current.pendingQuestions || []), event.request];
      if (event.type === 'questions.resolved') current.pendingQuestions = (current.pendingQuestions || []).filter(item => item.requestId !== event.requestId);
      if (event.type === 'command') streams.get(id).set('command:' + event.id, { role: 'tool', ...event, status: event.status || (event.exitCode == null ? 'running' : 'completed') });
      if (event.type === 'activity') streams.get(id).set('activity:' + event.item.id, { role: 'activity', ...event.item });
      if (event.type === 'message') streams.get(id).set(event.id, { role: 'assistant', text: event.text, phase: event.phase });
      if (event.type === 'error' && selected === id) error(event.error);
      if (event.type === 'done') { doneReceived = true; streams.delete(id); }
      render();
    };
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const lines = buffer.split('\n'); buffer = lines.pop(); lines.forEach(handle);
      if (done) { handle(buffer); break; }
    }
    if (!doneReceived && chats.some(chat => chat.id === id)) throw new Error('Connection ended before Codex finished. Refresh to load saved history.');
  } catch (e) {
    if (!id || chats.some(chat => chat.id === id)) error(e.message);
    try { chats = await api('/chats'); } catch {}
  } finally { if (id) { inFlight.delete(id); streams.delete(id); } render(); }
};
document.addEventListener('keydown', event => {
  if ((event.metaKey || event.ctrlKey) && event.code === 'Period') {
    event.preventDefault();
    if (commandMode) finishCommand(); else {
      if ($('#prompt').value.trim()) return error('Add the command first, then write your message after pressing Escape.');
      commandMode = true; composer();
    }
    $('#prompt').focus();
  }
  if (event.key === 'Escape' && commandMode) { event.preventDefault(); finishCommand(); $('#prompt').focus(); }
});
composer();
$('#prompt').onkeydown = event => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); $('#composer').requestSubmit(); }
};
try {
  [status, chats] = await Promise.all([api('/status'), api('/chats')]);
  selected = chats[0]?.id || null;
  $('#model').textContent = status.model || 'Unavailable';
  $('#model').title = status.binary || '';
  if (!status.ready) error(status.error);
  render();
} catch (e) { error(e.message); }
// A reloaded page can observe a turn still running on the backend.
let refreshing = false;
setInterval(async () => {
  if (refreshing || !chats.some(chat => chat.busy && !inFlight.has(chat.id))) return;
  refreshing = true;
  try {
    const latest = await api('/chats');
    chats = chats.map(chat => inFlight.has(chat.id) ? chat : latest.find(item => item.id === chat.id) || chat);
    render();
  } catch (e) { error(e.message); }
  finally { refreshing = false; }
}, 2000);
