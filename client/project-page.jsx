import React, { useEffect, useState } from 'react';
import { TaskGraph } from './task-graph.jsx';
import { TaskEditor, TaskViewer, TaskModal } from './task-editor.jsx';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

const columns = [['todo', 'To do'], ['progress', 'In progress'], ['blocked', 'Blocked'], ['done', 'Done']];
const docUrl = (cwd, file) => '/api/project/document?path=' + encodeURIComponent(cwd) + '&file=' + encodeURIComponent(file);
export function ProjectPage({ cwd, section = 'all', onSectionChange = () => {}, active = true, contentVersion = 0, onExecutionEvent = () => {} }) {
  const [dragging, setDragging] = useState('');
  const [dropColumn, setDropColumn] = useState('');
  const [moving, setMoving] = useState('');
  const [taskView, setTaskView] = useState('board');
  const [historyLimit, setHistoryLimit] = useState(50);
  const [viewing, setViewing] = useState(null);
  const [editing, setEditing] = useState(null);
  const [executing, setExecuting] = useState(false);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState('');
  const [task, setTask] = useState(null);
  const [text, setText] = useState('');
  const [docError, setDocError] = useState('');
  const [query, setQuery] = useState('');
  const [phase, setPhase] = useState('');
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    setError('');
    fetch('/api/project/content?path=' + encodeURIComponent(cwd), { signal: controller.signal }).then(async response => {
      const next = await response.json(); if (!response.ok) throw new Error(next.error);
      setData(next); setTask(null);
      setSelected(previous => next.documents.some(doc => doc.path === previous) ? previous : next.documents.find(doc => doc.path === '.planning/PROJECT.md')?.path || next.documents[0]?.path || '');
    }).catch(error => { if (error.name !== 'AbortError') setError(error.message); });
    return () => controller.abort();
  }, [cwd, refresh, active, contentVersion]);
  useEffect(() => {
    setText(''); setDocError('');
    if (!selected || /\.pdf$/i.test(selected)) return;
    const controller = new AbortController();
    fetch(docUrl(cwd, selected), { signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error((await response.json()).error);
      setText(await response.text());
    }).catch(error => { if (error.name !== 'AbortError') setDocError(error.message); });
    return () => controller.abort();
  }, [cwd, selected, refresh]);
  const tasks = (data?.tasks || []).filter(item => (!phase || item.phase === phase) && (item.title + ' ' + item.description).toLowerCase().includes(query.toLowerCase()));
  async function mutate(method, values) {
    setError('');
    try {
      const response = await fetch('/api/project/tasks', { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cwd, ...values }) });
      const result = await response.json(); if (!response.ok) throw new Error(result.error);
      setEditing(null); setRefresh(value => value + 1);
    } catch (error) { setError(error.message); throw error; }
  }
  async function moveTask(item, status) {
    if (!item || item.status === status || item.execution?.status === 'running' || moving) return;
    setMoving(item.id);
    try { await mutate('PATCH', { id: item.id, status }); } catch {} finally { setMoving(''); setDragging(''); setDropColumn(''); }
  }
  async function reassess(item) {
    setError('');
    try { const response = await fetch('/api/project/tasks/assess', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cwd, id: item.id }) }); const result = await response.json(); if (!response.ok) throw new Error(result.error); setRefresh(value => value + 1); } catch (error) { setError(error.message); }
  }
  async function execute(item) {
    let chatId, started = false;
    setExecuting(true); setError('');
    try {
      const response = await fetch('/api/chats', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cwd }) });
      const chat = await response.json(); if (!response.ok) throw new Error(chat.error);
      chatId = chat.id;
      const run = await fetch('/api/chats/' + chat.id + '/messages', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: item.title, taskId: item.id }) });
      if (!run.ok) throw new Error((await run.json()).error);
      started = true; setTask(null); onSectionChange('chat');
      const reader = run.body.getReader(); const decoder = new TextDecoder(); let pending = '';
      while (true) {
        const { value, done } = await reader.read(); if (done) break;
        pending += decoder.decode(value, { stream: true });
        const lines = pending.split('\n'); pending = lines.pop();
        for (const line of lines.filter(Boolean)) { const event = JSON.parse(line); onExecutionEvent(chat.id, event); if (event.type === 'error') setError(event.error); }
      }
    } catch (error) { setError(error.message); }
    finally { setExecuting(false); if (started) { onExecutionEvent(chatId, { type: 'execution.finished' }); setRefresh(value => value + 1); } }
  }
  function localLink(href) {
    if (!href || /^(?:[a-z]+:|\/\/|#)/i.test(href)) return null;
    const base = selected.split('/'); base.pop();
    for (const part of decodeURIComponent(href.split('#')[0]).split('/')) { if (part === '..') base.pop(); else if (part && part !== '.') base.push(part); }
    const path = base.join('/');
    return data?.documents.some(doc => doc.path === path) ? path : null;
  }
  const isDocs = section === 'docs';
  const phases = [...new Set((data?.tasks || []).map(task => task.phase))];
  function openDocument(path) { setSelected(path); setTask(null); onSectionChange('docs'); }
  return <div className="project-page focused-project-page">
    <div className="project-page-heading"><div><h1>{isDocs ? 'Documentation' : 'Tasks'}</h1></div><div className="project-toolbar"><button className="quiet-button" aria-label="Refresh from disk" onClick={() => setRefresh(value => value + 1)}>Refresh</button>{!isDocs && <button className="primary-action" onClick={() => setEditing({ title: '', description: '', status: 'todo' })}>New task</button>}</div></div>
    {error && <p role="alert">{error}</p>}
    {!data && !error && <p role="status">Loading project…</p>}
    {data && <>
      {!!data.warnings.length && <details className="scan-notes"><summary>Project scan notes</summary>{data.warnings.map((warning, index) => <p key={index}>{warning}</p>)}</details>}
      {!isDocs && <>
        <nav className="task-view-nav" aria-label="Task views">{[['board', 'Board'], ['graph', 'Graph'], ['history', 'History']].map(([value, label]) => <button key={value} aria-current={taskView === value ? 'page' : undefined} onClick={() => setTaskView(value)}>{label}</button>)}</nav>
        {taskView !== 'history' && <div className="board-filters"><input aria-label="Search tasks" placeholder="Search tasks…" value={query} onChange={event => setQuery(event.target.value)} />{phases.length > 1 && <select aria-label="Filter by phase" value={phase} onChange={event => setPhase(event.target.value)}><option value="">All phases</option>{phases.map(phase => <option key={phase}>{phase}</option>)}</select>}<span>{tasks.length} tasks</span></div>}
        {moving && <p className="board-note" role="status">Moving task…</p>}
        {executing && <p className="execution-notice" role="status">Task running. <button onClick={() => onSectionChange('chat')}>View in chat</button></p>}
        {taskView === 'board' && <div className="task-board" aria-label="Project task board">{columns.map(([status, label]) => <section className={'board-column ' + status + (dropColumn === status ? ' drop-target' : '')} key={status} aria-label={label} onDragOver={event => { if (dragging && !moving) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; setDropColumn(status); } }} onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget)) setDropColumn(''); }} onDrop={event => { event.preventDefault(); const item = data.tasks.find(task => task.id === dragging); setDropColumn(''); if (item) moveTask(item, status); }}><h2>{label}<span>{tasks.filter(task => task.status === status).length}</span></h2>{tasks.filter(task => task.status === status).map(item => <button className={'task-card' + (dragging === item.id ? ' dragging' : '')} draggable={!moving && item.execution?.status !== 'running'} title="Drag to another column or open to change status" onDragStart={event => { if (item.execution?.status === 'running' || moving) { event.preventDefault(); return; } event.dataTransfer.setData('text/plain', item.id); event.dataTransfer.effectAllowed = 'move'; setDragging(item.id); }} onDragEnd={() => { setDragging(''); setDropColumn(''); }} aria-pressed={task?.id === item.id} key={item.id} onClick={() => setTask(item)}><strong>{item.title}</strong>{item.assessment?.needsClarification && <small>Needs clarification</small>}{item.images?.length > 0 && <small>{item.images.length} attachment{item.images.length === 1 ? '' : 's'}</small>}</button>)}{!tasks.some(task => task.status === status) && <p className="board-note">No tasks</p>}</section>)}</div>}
        {taskView === 'graph' && <TaskGraph tasks={tasks} audit={data.audit} onSelect={setTask} />}
        {taskView === 'history' && <section className="project-history" aria-label="Project audit log"><h2>Activity</h2>{!(data.audit || []).length && <p className="board-note">No activity yet.</p>}<ol>{(data.audit || []).slice(0, historyLimit).map(entry => <li key={entry.id}><div><strong>{entry.title}</strong><span>{({ 'task.created': 'Task created', 'task.updated': 'Task updated', 'task.deleted': 'Task deleted', 'task.assessed': 'Impact evaluated', 'execution.running': 'Execution started', 'execution.completed': 'Execution completed', 'execution.failed': 'Execution failed', 'execution.cancelled': 'Execution cancelled', 'execution.interrupted': 'Execution interrupted', 'execution.model_selected': 'Model selected' })[entry.action] || entry.action}{entry.route && ` · ${entry.route.model}`}</span>{entry.error && <span role="alert">{entry.error}</span>}</div><time dateTime={entry.at}>{new Date(entry.at).toLocaleString()}</time></li>)}</ol>{(data.audit || []).length > historyLimit && <button onClick={() => setHistoryLimit(value => value + 50)}>Load more activity</button>}</section>}
      </>}
      {editing && <TaskEditor task={editing} onClose={() => setEditing(null)} onSave={values => mutate(values.id ? 'PATCH' : 'POST', values)} />}
      {viewing && <TaskViewer task={viewing} onClose={() => setViewing(null)} />}
      {task && !editing && !viewing && <TaskModal title={task.title} onClose={() => setTask(null)} className="task-detail">
        <div className="task-status-line"><label>Status <select aria-label="Task status" disabled={!!moving || task.execution?.status === 'running'} value={task.status} onChange={event => moveTask(task, event.target.value)}>{columns.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>{task.assessment?.impact && task.assessment.impact !== 'unknown' && <span>PRD: {task.assessment.impact}</span>}</div>
        {error && <p role="alert">{error}</p>}
        <p className="task-description">{task.description || 'No description.'}</p>
        {task.assessment?.needsClarification && <p className="task-attention" role="status">The orchestrator will clarify missing details in chat before making changes.</p>}
        {task.assessment?.warning && <details className="task-attention"><summary>Evaluation needs attention</summary><p>{task.assessment.warning}</p></details>}
        <div className="project-toolbar task-main-actions"><button className="primary-action" disabled={executing || task.execution?.status === 'running'} onClick={() => execute(task)}>Run task</button><button disabled={task.execution?.status === 'running'} onClick={() => setEditing(task)}>Edit task</button><button onClick={() => setViewing(task)}>Open viewer{task.images?.length ? ` · ${task.images.length} images` : ''}</button></div>
        {task.execution && <p className="board-note">Last run: {task.execution.status}</p>}
        <details className="task-more"><summary>Impact and execution details</summary>
          {task.assessment && <div className="task-assessment"><strong>PRD impact: {task.assessment.impact} · {task.assessment.status}</strong>{task.assessment.route && <p>Model: {task.assessment.route.model} · {task.assessment.route.source}</p>}{task.assessment.confidence !== undefined && <p>{Math.round(task.assessment.confidence * 100)}% impact confidence</p>}{task.assessment.prdPath && <button onClick={() => openDocument(task.assessment.prdPath)}>Open PRD</button>}{task.assessment.totalTasks > task.assessment.comparedTasks && <p>Compared with {task.assessment.comparedTasks} of {task.assessment.totalTasks} existing tasks.</p>}<button disabled={task.execution?.status === 'running'} onClick={() => reassess(task)}>Re-evaluate impact and model</button></div>}
          {task.execution?.outcome && <details><summary>Execution report</summary><pre>{task.execution.outcome}</pre></details>}
          {!!task.docs.length && <div className="doc-chips">{task.docs.map(path => <button key={path} onClick={() => openDocument(path)}>{path}</button>)}</div>}
          <button className="delete-task" disabled={task.execution?.status === 'running'} onClick={() => mutate('DELETE', { id: task.id }).catch(() => {})}>Delete task</button>
        </details>
      </TaskModal>}
      <section hidden={!isDocs} className="document-workspace" aria-label="Project documentation"><div className="document-list"><h2>Documents</h2>{data.documents.map(doc => <button key={doc.path} title={doc.path} className={selected === doc.path ? 'active' : ''} onClick={() => setSelected(doc.path)}>{doc.name || doc.path.split('/').at(-1)}</button>)}{!data.documents.length && <p>No project documents yet.</p>}</div>
        <div className="document-reader"><div className="document-heading"><strong>{selected?.split('/').at(-1) || 'Select a document'}</strong>{selected && <a href={docUrl(cwd, selected)} target="_blank" rel="noreferrer">Open original ↗</a>}</div>
          {docError && <p role="alert">{docError}</p>}
          {selected && (/\.pdf$/i.test(selected) ? <iframe key={selected} title={'PDF: ' + selected} src={docUrl(cwd, selected)} /> : <div className="markdown-reader"><Markdown remarkPlugins={[remarkGfm]} components={{ a: ({ href, children }) => { const local = localLink(href); return local ? <a href={docUrl(cwd, local)} onClick={event => { event.preventDefault(); setSelected(local); }}>{children}</a> : <a href={href} target="_blank" rel="noreferrer">{children}</a>; }, img: ({ alt }) => <span>[Image: {alt || 'embedded image'}]</span> }}>{text || (docError ? '' : 'Loading document…')}</Markdown></div>)}
        </div>
      </section>
    </>}
  </div>;
}
