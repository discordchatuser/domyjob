import { TerminalOutput } from './terminal.jsx';
import React, { useEffect, useRef, useState } from 'react';

async function request(path, options) {
  const response = await fetch('/api' + path, options);
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Request failed');
  return result;
}

export function FolderBrowser({ initialPath, onLoad, onClose }) {
  const [folder, setFolder] = useState(null);
  const [path, setPath] = useState(initialPath || '');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const dialog = useRef(null);
  async function browse(value) {
    setLoading(true); setError('');
    try { const next = await request('/folders?path=' + encodeURIComponent(value)); setFolder(next); setPath(next.cwd); }
    catch (error) { setError(error.message); }
    finally { setLoading(false); }
  }
  useEffect(() => { dialog.current.showModal(); browse(initialPath || ''); }, []);
  return <dialog ref={dialog} className="folder-browser" onCancel={onClose}>
    <div className="project-toolbar"><strong>Load project from disk</strong><button onClick={onClose}>Close</button></div>
    <form onSubmit={event => { event.preventDefault(); browse(path); }}><input aria-label="Folder path" value={path} onChange={event => setPath(event.target.value)} /><button disabled={loading}>Go</button></form>
    <p role="alert">{error}</p>
    <div className="folder-list"><button disabled={!folder || loading} onClick={() => browse(folder.parent)}>↑ Parent folder</button>
      {folder?.folders.map(item => <button disabled={loading} key={item.path} onClick={() => browse(item.path)}>▸ {item.name}</button>)}
    </div>
    <button disabled={!folder || loading} onClick={() => onLoad(folder.cwd)}>Load {folder?.name || 'folder'}</button>
  </dialog>;
}

export function ProjectConsole({ cwd, expanded = false }) {
  const [command, setCommand] = useState('');
  const [server, setServer] = useState({ status: 'stopped', output: '' });
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const [open, setOpen] = useState(expanded);
  useEffect(() => {
    let disposed = false;
    request('/project?path=' + encodeURIComponent(cwd)).then(project => { if (!disposed) setCommand(project.command); }).catch(error => { if (!disposed) setError(error.message); });
    let timer;
    async function refresh() {
      try { const next = await request('/project/server?path=' + encodeURIComponent(cwd)); if (!disposed) { setServer(next); } }
      catch (error) { if (!disposed) setError(error.message); }
      if (!disposed) timer = setTimeout(refresh, 750);
    }
    refresh();
    return () => { disposed = true; clearTimeout(timer); };
  }, [cwd]);
  async function control(method) {
    setPending(true); setError(''); setOpen(true);
    try { setServer(await request('/project/server', { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cwd, command }) })); }
    catch (error) { setError(error.message); }
    finally { setPending(false); }
  }
  const running = server.status === 'running' || server.status === 'stopping';
  return <section className={'project-console' + (expanded ? ' expanded-console' : '')} aria-label="Project server">
    <div className="project-toolbar"><span title={cwd} className="project-path">{cwd}</span><span role="status">{server.status}</span>{!expanded && <button onClick={() => setOpen(!open)} aria-expanded={open}>Console</button>}</div>
    <form className="project-toolbar" onSubmit={event => { event.preventDefault(); control('POST'); }}>
      <input aria-label="Server command" placeholder="Server command, e.g. npm run dev" value={command} disabled={running || pending} onChange={event => setCommand(event.target.value)} />
      <button disabled={pending || running || !command.trim()}>Start server</button><button type="button" disabled={pending || !running} onClick={() => control('DELETE')}>Stop</button>
    </form>
    {error && <p role="alert">{error}</p>}
    {open && <TerminalOutput server={server} />}

  </section>;
}
