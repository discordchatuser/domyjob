import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { QuestionCard } from './questions.jsx';
import { Gallery } from './gallery.jsx';
import { Message } from './transcript.jsx';
import { useVoice } from './voice.js';
import { applyStreamEvent, emptyDraft, recordAnswer } from './chat-state.js';

async function api(path, options) {
  const response = await fetch('/api' + path, options);
  if (!response.ok) throw new Error((await response.json()).error || 'Request failed');
  return response.json();
}
const post = body => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

export default function App() {
  const [chats, setChats] = useState([]);
  const [selected, setSelected] = useState(null);
  const [status, setStatus] = useState({});
  const [error, setError] = useState('');
  const [workspace, setWorkspace] = useState('');
  const [drafts, setDrafts] = useState({});
  const [questionDrafts, setQuestionDrafts] = useState({});
  const [inFlight, setInFlight] = useState(new Set());
  const [creating, setCreating] = useState(false);
  const [gallery, setGallery] = useState(null);
  const selectedRef = useRef(selected); selectedRef.current = selected;
  const chatsRef = useRef(chats); chatsRef.current = chats;
  const active = useRef(new Set());
  const controllers = useRef(new Map());
  const promptRef = useRef(null);
  const messagesRef = useRef(null);
  const follow = useRef(true);
  const chat = chats.find(item => item.id === selected);
  const draftKey = selected || 'new';
  const draft = drafts[draftKey] || emptyDraft();
  const updateDraft = useCallback(patch => setDrafts(previous => ({ ...previous, [draftKey]: { ...(previous[draftKey] || emptyDraft()), ...patch } })), [draftKey]);
  const voice = useVoice({ value: draft.text, onChange: text => updateDraft({ text }), onError: setError, onFocus: () => promptRef.current?.focus() });
  const busy = inFlight.has(selected) || chat?.busy;
  const items = [...(chat?.messages || []), ...Object.values(chat?.stream || {})];

  useEffect(() => {
    let mounted = true;
    Promise.all([api('/status'), api('/chats')]).then(([nextStatus, nextChats]) => {
      if (!mounted) return;
      setStatus(nextStatus); setChats(nextChats); setSelected(nextChats[0]?.id || null);
      if (!nextStatus.ready) setError(nextStatus.error);
    }).catch(error => { if (mounted) setError(error.message); });
    return () => { mounted = false; for (const controller of controllers.current.values()) controller.abort(); };
  }, []);

  useEffect(() => {
    let disposed = false, refreshing = false;
    const timer = setInterval(async () => {
      if (refreshing || !chatsRef.current.some(item => item.busy && !active.current.has(item.id))) return;
      refreshing = true;
      try {
        const latest = await api('/chats');
        if (!disposed) setChats(previous => previous.map(item => active.current.has(item.id) ? item : latest.find(next => next.id === item.id) || item));
      } catch (error) { if (!disposed) setError(error.message); }
      finally { refreshing = false; }
    }, 2000);
    return () => { disposed = true; clearInterval(timer); };
  }, []);

  useLayoutEffect(() => { follow.current = true; }, [selected]);
  useLayoutEffect(() => {
    const node = messagesRef.current;
    if (follow.current && node) node.scrollTop = node.scrollHeight;
  }, [chats, selected, inFlight]);

  function finishCommand() {
    updateDraft({ text: '', commandMode: false, commands: draft.text.trim() ? [...draft.commands, draft.text.trim()] : draft.commands });
  }
  useEffect(() => {
    function keydown(event) {
      if ((event.metaKey || event.ctrlKey) && event.code === 'Period') {
        event.preventDefault(); voice.cancel();
        if (draft.commandMode) finishCommand();
        else if (draft.text.trim()) setError('Add the command first, then write your message after pressing Escape.');
        else updateDraft({ commandMode: true });
        promptRef.current?.focus();
      }
      if (event.key === 'Escape' && voice.listening) { event.preventDefault(); voice.stop(); }
      if (event.key === 'Escape' && draft.commandMode) { event.preventDefault(); finishCommand(); promptRef.current?.focus(); }
    }
    document.addEventListener('keydown', keydown);
    return () => document.removeEventListener('keydown', keydown);
  });

  function chooseThread(id) { voice.cancel(); setGallery(null); setSelected(id); setError(''); }
  async function createThread() {
    const created = await api('/chats', post({ cwd: workspace.trim() }));
    setChats(previous => [created, ...previous]);
    chooseThread(created.id);
    return created;
  }
  async function newThread() {
    if (creating) return;
    setCreating(true);
    try { await createThread(); } catch (error) { setError(error.message); }
    finally { setCreating(false); }
  }
  async function deleteThread(id) {
    try {
      if (selectedRef.current === id) voice.cancel();
      await api('/chats/' + id, { method: 'DELETE' });
      controllers.current.get(id)?.abort(); controllers.current.delete(id); active.current.delete(id);
      setInFlight(new Set(active.current));
      const remaining = chatsRef.current.filter(item => item.id !== id);
      setChats(previous => previous.filter(item => item.id !== id));
      setDrafts(previous => { const next = { ...previous }; delete next[id]; return next; });
      if (selectedRef.current === id) chooseThread(remaining[0]?.id || null);
      setError('');
    } catch (error) { setError(error.message); }
  }
  async function answerQuestions(chatId, requestId, answers) {
    const result = await api(`/chats/${chatId}/questions/${requestId}`, post({ answers }));
    setChats(previous => previous.map(item => item.id === chatId ? recordAnswer(item, requestId, result.message) : item));
    setQuestionDrafts(previous => { const next = { ...previous }; delete next[requestId]; return next; });
  }
  async function send(event) {
    event.preventDefault();
    if (!status.ready || busy || creating || active.current.has(selected)) return;
    if (voice.listening) { voice.stop(); return; }
    const text = draft.commandMode ? '' : draft.text.trim();
    const commands = draft.commandMode && draft.text.trim() ? [...draft.commands, draft.text.trim()] : [...draft.commands];
    if (!text && !commands.length) return;
    let id;
    if (!chat) setCreating(true);
    try {
      const target = chat || await createThread(); id = target.id;
      active.current.add(id); setInFlight(new Set(active.current));
      const controller = new AbortController(); controllers.current.set(id, controller);
      setDrafts(previous => ({ ...previous, [id]: emptyDraft(), ...(chat ? {} : { new: emptyDraft() }) }));
      setError('');
      setChats(previous => previous.map(item => item.id === id ? { ...item, stream: {}, messages: [...item.messages, { role: 'user', text, commands }] } : item));
      const response = await fetch(`/api/chats/${id}/messages`, { ...post({ prompt: text, commands }), signal: controller.signal });
      if (!response.ok) throw new Error((await response.json()).error || 'Request failed');
      const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = '', doneReceived = false;
      function handle(line) {
        if (!line.trim()) return;
        const next = JSON.parse(line);
        if (next.type === 'done') doneReceived = true;
        if (next.type === 'error' && selectedRef.current === id) setError(next.error);
        setChats(previous => previous.map(item => item.id === id ? applyStreamEvent(item, next) : item));
      }
      while (true) {
        const { value, done } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });
        const lines = buffer.split('\n'); buffer = lines.pop(); lines.forEach(handle);
        if (done) { handle(buffer); break; }
      }
      if (!doneReceived) throw new Error('Connection ended before Codex finished. Refresh to load saved history.');
    } catch (error) {
      if (error.name !== 'AbortError') {
        if (!id || selectedRef.current === id) setError(error.message);
        try {
          const latest = await api('/chats');
          setChats(previous => previous.map(item => item.id === id ? latest.find(next => next.id === id) || item : item));
        } catch {}
      }
    } finally {
      if (id) {
        active.current.delete(id); controllers.current.delete(id); setInFlight(new Set(active.current));
        setChats(previous => previous.map(item => item.id === id ? { ...item, stream: {} } : item));
      }
      setCreating(false);
    }
  }
  const openImage = imageId => setGallery({ chatId: selected, imageId });
  return <>
    <aside><div className="brand">◈ <strong>Local Codex</strong></div>
      <button id="new" onClick={newThread} disabled={creating}>＋ New thread</button>
      <label className="workspace">Working directory for new threads<input id="workspace" placeholder="Default project folder" aria-label="Working directory for new threads" value={workspace} onChange={event => setWorkspace(event.target.value)} /></label>
      <nav id="threads" aria-label="Threads">{chats.map(item => <div className="thread-row" key={item.id}><button className={item.id === selected ? 'active' : ''} onClick={() => chooseThread(item.id)}>{item.title}</button><button className="delete-thread" title="Delete thread" aria-label={'Delete ' + item.title} onClick={() => deleteThread(item.id)}>×</button></div>)}</nav>
      <div className="local">On your machine</div>
    </aside>
    <main><header><span id="title" title={chat?.cwd || 'Default working directory'}>{chat?.title || 'New conversation'}</span>
      <button id="gallery" type="button" hidden={!chat?.images?.length} onClick={() => openImage()}>Images ({chat?.images?.length || 0})</button>
      <span id="model" className={chat?.routing ? 'routing' : ''} role="status" title={chat?.modelRoute?.reason || status.binary || ''}>{chat?.routing ? 'Assessing task difficulty…' : chat?.model ? `${chat.model}${chat.modelRoute?.tier ? ' · ' + chat.modelRoute.tier : ''}` : status.model || 'Connecting…'}</span>
    </header>
      <div id="messages" ref={messagesRef} aria-live="polite" onScroll={event => { const node = event.currentTarget; follow.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80; }}>
        {!items.length && <div className="empty"><h1>› What are we working on?</h1><p>Start a thread and send a prompt to your local Codex.</p></div>}
        <div key={selected || 'new'}>{items.map((item, index) => <Message key={item.questionResponse ? 'answer:' + item.questionResponse.requestId : item.id ? item.role + ':' + item.id : 'message:' + index} item={item} onOpenImage={openImage} />)}
          {(chat?.pendingQuestions || []).map(request => <QuestionCard key={request.requestId} request={request} draft={questionDrafts[request.requestId]} onChange={(questionId, value) => setQuestionDrafts(previous => ({ ...previous, [request.requestId]: { ...previous[request.requestId], [questionId]: value } }))} onSubmit={answers => answerQuestions(chat.id, request.requestId, answers)} />)}
        </div>
        {busy && !chat?.pendingQuestions?.length && <div className="waiting">{chat?.routing ? 'Assessing task difficulty before starting…' : 'Codex is working…'}</div>}
      </div>
      <footer><div id="error" role="alert">{error}</div>
        <div id="commands">{draft.commands.map((command, index) => <button type="button" className="command-chip" title="Remove command" key={index} onClick={() => updateDraft({ commands: draft.commands.filter((_, position) => position !== index) })}>$ {command} ×</button>)}</div>
        <div id="mode">{draft.commandMode ? 'Command · Esc to add' : 'Cmd+. to add a command'}</div>
        <div id="voice-status" role="status" aria-live="polite">{voice.status}</div>
        <form id="composer" className={draft.commandMode ? 'command-mode' : ''} onSubmit={send}>
          <textarea id="prompt" ref={promptRef} rows="2" aria-label="Prompt" placeholder={draft.commandMode ? 'npm run dev' : 'Ask Codex anything…'} value={draft.text} readOnly={voice.listening} onChange={event => updateDraft({ text: event.target.value })} onKeyDown={event => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.form.requestSubmit(); }
          }} />
          <button id="dictate" type="button" hidden={!voice.available} disabled={!voice.available} title="Dictate a message (microphone permission required)" aria-pressed={voice.listening} onClick={voice.toggle}>{voice.listening ? 'Stop mic' : 'Mic'}</button>
          <button id="send" type="submit" disabled={!status.ready || busy || creating}>Send ↑</button>
        </form>
        <p>Enter to send · Shift + Enter for a new line · Cmd+. for commands</p>
      </footer>
    </main>
    {gallery?.chatId === selected && chat?.images?.length > 0 && <Gallery key={gallery.chatId + ':' + (gallery.imageId || '')} images={chat.images} imageId={gallery.imageId} onClose={() => setGallery(null)} />}
  </>;
}
