import './style.css';
const $ = selector => document.querySelector(selector);
let chats = [], selected = null, status = {}, inFlight = new Set();
const drafts = new Map();
let commandMode = false, commands = [];
function saveDraft() {
  if (selected) drafts.set(selected, { text: $('#prompt').value, commands: [...commands], commandMode });
}
function composer() {
  $('form').classList.toggle('command-mode', commandMode);
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
  messages.replaceChildren();
  const items = [...(chat?.messages || [])];
  for (const text of streams.get(selected)?.values() || []) items.push({ role: 'assistant', text });
  if (!items.length) {
    const empty = document.createElement('div'); empty.className = 'empty';
    const heading = document.createElement('h1'); heading.textContent = 'What are we working on?';
    const text = document.createElement('p'); text.textContent = 'Start a thread and send a prompt to your local Codex.';
    empty.append(heading, text); messages.append(empty);
  }
  for (const item of items) {
    const article = document.createElement('article'); article.className = item.role;
    const label = document.createElement('span'); label.className = 'label'; label.textContent = { user: 'You', assistant: 'Codex', error: 'Error' }[item.role];
    const text = document.createElement('div'); text.className = 'text'; text.textContent = item.text;
    for (const command of item.commands || []) { const code = document.createElement('pre'); code.className = 'command-chip'; code.textContent = '$ ' + command; text.append(code); }
    article.append(label, text); messages.append(article);
  }
  if (inFlight.has(selected)) { const waiting = document.createElement('div'); waiting.className = 'waiting'; waiting.textContent = 'Codex is working…'; messages.append(waiting); }
  messages.scrollTop = messages.scrollHeight;
  $('#send').disabled = !status.ready || inFlight.has(selected);
}
async function newChat() {
  const chat = await api('/chats', { method: 'POST' });
  saveDraft();
  chats.unshift(chat); selected = chat.id; $('#prompt').value = ''; commands = []; commandMode = false; composer(); render(); return chat;
}
$('#new').onclick = () => newChat().catch(e => error(e.message));
$('form').onsubmit = async event => {
  event.preventDefault();
  if (!status.ready || inFlight.has(selected)) return;
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
      if (event.type === 'command') streams.get(id).set('command:' + event.id, '$ ' + event.command + '\n' + (event.output || 'Running…') + (event.exitCode == null ? '' : '\nExit code: ' + event.exitCode));
      if (event.type === 'message') streams.get(id).set(event.id, event.text);
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
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); $('form').requestSubmit(); }
};
try {
  [status, chats] = await Promise.all([api('/status'), api('/chats')]);
  selected = chats[0]?.id || null;
  $('#model').textContent = status.model || 'Unavailable';
  $('#model').title = status.binary || '';
  if (!status.ready) error(status.error);
  render();
} catch (e) { error(e.message); }
