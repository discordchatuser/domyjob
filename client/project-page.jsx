import React, { useEffect, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

const columns = [['todo', 'To do'], ['progress', 'In progress'], ['blocked', 'Blocked'], ['done', 'Done']];
const docUrl = (cwd, file) => '/api/project/document?path=' + encodeURIComponent(cwd) + '&file=' + encodeURIComponent(file);
export function ProjectPage({ cwd, section = 'all', onSectionChange = () => {} }) {
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
    const controller = new AbortController();
    setError('');
    fetch('/api/project/content?path=' + encodeURIComponent(cwd), { signal: controller.signal }).then(async response => {
      const next = await response.json(); if (!response.ok) throw new Error(next.error);
      setData(next); setTask(null);
      setSelected(previous => next.documents.some(doc => doc.path === previous) ? previous : next.documents.find(doc => doc.path === '.planning/PROJECT.md')?.path || next.documents[0]?.path || '');
    }).catch(error => { if (error.name !== 'AbortError') setError(error.message); });
    return () => controller.abort();
  }, [cwd, refresh]);
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
  function localLink(href) {
    if (!href || /^(?:[a-z]+:|\/\/|#)/i.test(href)) return null;
    const base = selected.split('/'); base.pop();
    for (const part of decodeURIComponent(href.split('#')[0]).split('/')) { if (part === '..') base.pop(); else if (part && part !== '.') base.push(part); }
    const path = base.join('/');
    return data?.documents.some(doc => doc.path === path) ? path : null;
  }
  return <div className="project-page">
    <div className="project-page-heading"><div><h1>Project workspace</h1><p>{cwd}</p></div><button onClick={() => setRefresh(value => value + 1)}>Refresh from disk</button></div>
    {error && <p role="alert">{error}</p>}
    {!data && !error && <p role="status">Reading project tasks and documents…</p>}
    {data && <>
      {data.warnings.map((warning, index) => <p key={index}>{warning}</p>)}
      <div className="board-filters"><input aria-label="Search tasks and documents" placeholder="Search tasks and documents…" value={query} onChange={event => setQuery(event.target.value)} /><select aria-label="Filter by phase" value={phase} onChange={event => setPhase(event.target.value)}><option value="">All phases</option>{[...new Set(data.tasks.map(task => task.phase))].map(phase => <option key={phase}>{phase}</option>)}</select><span>{tasks.length} tasks · {data.documents.length} documents</span></div>
      <p className="board-note">Read from project plans, summaries and roadmap checkboxes. Refresh to pick up changes on disk.</p>
      <div hidden={section === 'docs'} className="task-board" aria-label="Project task board">{columns.map(([status, label]) => <section className={'board-column ' + status} key={status} aria-label={label}><h2>{label}<span>{tasks.filter(task => task.status === status).length}</span></h2>{tasks.filter(task => task.status === status).map(item => <button className="task-card" aria-pressed={task?.id === item.id} key={item.id} onClick={() => { setTask(item); setSelected(item.source); }}><small>{item.phase}</small><strong>{item.title}</strong><span>{item.docs.length} source documents ↗</span></button>)}{!tasks.some(task => task.status === status) && <p className="board-note">No tasks</p>}</section>)}</div>
      {!data.tasks.length && <p>No task plans or roadmap checkboxes found. Documents are available below.</p>}
      {task && <section className="task-detail"><div className="project-toolbar"><strong>{task.title}</strong><button onClick={() => setTask(null)}>Close task</button></div><p>{task.description}</p><div className="doc-chips">{task.docs.map(path => <button key={path} onClick={() => { setSelected(path); onSectionChange('docs'); }}>{path}</button>)}</div></section>}
      <section hidden={section === 'tasks'} className="document-workspace" aria-label="Project documentation"><div className="document-list"><h2>Documents</h2>{data.documents.filter(doc => doc.path.toLowerCase().includes(query.toLowerCase())).map(doc => <button key={doc.path} title={doc.path} className={selected === doc.path ? 'active' : ''} onClick={() => setSelected(doc.path)}><small>{doc.type.toUpperCase()}</small>{doc.path}</button>)}{!data.documents.length && <p>No Markdown or PDF documents found.</p>}</div>
        <div className="document-reader"><div className="document-heading"><strong>{selected || 'Select a document'}</strong>{selected && <a href={docUrl(cwd, selected)} target="_blank" rel="noreferrer">Open original ↗</a>}</div>
          {docError && <p role="alert">{docError}</p>}
          {selected && (/\.pdf$/i.test(selected) ? <iframe key={selected} title={'PDF: ' + selected} src={docUrl(cwd, selected)} /> : <div className="markdown-reader"><Markdown remarkPlugins={[remarkGfm]} components={{ a: ({ href, children }) => { const local = localLink(href); return local ? <a href={docUrl(cwd, local)} onClick={event => { event.preventDefault(); setSelected(local); }}>{children}</a> : <a href={href} target="_blank" rel="noreferrer">{children}</a>; }, img: ({ alt }) => <span>[Image: {alt || 'embedded image'}]</span> }}>{text || (docError ? '' : 'Loading document…')}</Markdown></div>)}
        </div>
      </section>
    </>}
  </div>;
}
