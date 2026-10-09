import React, { useEffect, useRef, useState } from 'react';

export function TaskModal({ children, title, onClose, className = '' }) {
  const dialog = useRef(null);
  useEffect(() => { const node = dialog.current; node.showModal(); return () => node.close(); }, []);
  return <dialog ref={dialog} className={'task-modal ' + className} aria-label={title} onCancel={event => { event.preventDefault(); onClose(); }} onClick={event => { if (event.target === event.currentTarget) onClose(); }}><div className="project-toolbar"><h2>{title}</h2><button type="button" onClick={onClose}>Close</button></div>{children}</dialog>;
}

export function TaskViewer({ task, onChange, onClose, initialImage = null }) {
  const [imageIndex, setImageIndex] = useState(initialImage);
  const content = useRef(null);
  const drag = useRef(null);
  const [draft, setDraft] = useState(null);
  const image = imageIndex === null ? null : task.images?.[imageIndex];
  const highlights = task.highlights || [];
  const updateImage = marks => onChange({ ...task, images: task.images.map((item, index) => index === imageIndex ? { ...item, marks } : item) });
  function highlight() {
    const selection = window.getSelection();
    if (!selection?.rangeCount || selection.isCollapsed || !content.current.contains(selection.anchorNode) || !content.current.contains(selection.focusNode)) return;
    const range = selection.getRangeAt(0); const prefix = range.cloneRange(); prefix.selectNodeContents(content.current); prefix.setEnd(range.startContainer, range.startOffset);
    const start = prefix.toString().length, end = start + range.toString().length;
    onChange({ ...task, highlights: [...highlights, { start, end }].sort((a, b) => a.start - b.start).reduce((all, mark) => { const last = all.at(-1); if (last && mark.start <= last.end) last.end = Math.max(last.end, mark.end); else all.push({ ...mark }); return all; }, []) });
    selection.removeAllRanges();
  }
  function point(event) { const bounds = event.currentTarget.getBoundingClientRect(); return { x: Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)), y: Math.max(0, Math.min(1, (event.clientY - bounds.top) / bounds.height)) }; }
  let cursor = 0; const parts = [];
  for (const mark of highlights) { parts.push(task.description?.slice(cursor, mark.start), <mark key={mark.start}>{task.description?.slice(mark.start, mark.end)}</mark>); cursor = mark.end; }
  parts.push(task.description?.slice(cursor));
  return <TaskModal title="Task viewer" className="task-viewer" onClose={onClose}>
    <h3>{task.title || 'Untitled task'}</h3><div className="project-toolbar"><button type="button" onClick={() => setImageIndex(null)}>Description</button>{(task.images || []).map((item, index) => <button key={index} type="button" onClick={() => setImageIndex(index)}>{item.name}</button>)}</div>
    {image ? <><p>Drag over the image to mark an area.</p><div className="task-image-stage"><img src={image.data} alt={image.name} draggable="false" /><svg viewBox="0 0 1 1" preserveAspectRatio="none" aria-label="Image annotation area" onPointerDown={event => { if (!onChange) return; event.currentTarget.setPointerCapture(event.pointerId); drag.current = point(event); }} onPointerMove={event => { if (!drag.current) return; const end = point(event), start = drag.current; setDraft({ x: Math.min(start.x, end.x), y: Math.min(start.y, end.y), width: Math.abs(start.x - end.x), height: Math.abs(start.y - end.y) }); }} onPointerUp={event => { if (!drag.current) return; const end = point(event), start = drag.current; const rect = { x: Math.min(start.x, end.x), y: Math.min(start.y, end.y), width: Math.abs(start.x - end.x), height: Math.abs(start.y - end.y) }; if (rect.width > .005 && rect.height > .005) updateImage([...(image.marks || []), rect]); drag.current = null; setDraft(null); }} onPointerCancel={() => { drag.current = null; setDraft(null); }}>
      {[...(image.marks || []), ...(draft ? [draft] : [])].map((rect, index) => <rect key={index} {...rect} />)}
    </svg></div>{onChange && <button type="button" onClick={() => updateImage((image.marks || []).slice(0, -1))}>Undo last box</button>}</> : <><p>Select description text, then highlight it.</p><div ref={content} className="task-viewer-text">{parts}</div>{onChange && <div className="project-toolbar"><button type="button" onMouseDown={event => event.preventDefault()} onClick={highlight}>Highlight selection</button><button type="button" onClick={() => onChange({ ...task, highlights: [] })}>Clear highlights</button></div>}</>}
  </TaskModal>;
}

export function TaskEditor({ task, onSave, onClose }) {
  const [draft, setDraft] = useState(() => ({ ...task, images: task.images || [], highlights: task.highlights || [] }));
  const [viewer, setViewer] = useState(undefined);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  async function attach(event) {
    const files = [...event.target.files]; event.target.value = ''; setError(''); setUploading(true);
    try {
      if (draft.images.length + files.length > 4) throw new Error('Attach up to four images.');
      const images = await Promise.all(files.map(file => {
        if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type) || file.size > 2 * 1024 * 1024) throw new Error('Use PNG, JPEG, WebP or GIF images up to 2 MB each.');
        return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve({ name: file.name, data: reader.result, marks: [] }); reader.onerror = () => reject(new Error('Could not read image')); reader.readAsDataURL(file); });
      }));
      setDraft(previous => ({ ...previous, images: [...previous.images, ...images] }));
    } catch (error) { setError(error.message); } finally { setUploading(false); }
  }
  return <TaskModal title={task.id ? 'Edit task' : 'New task'} onClose={onClose}>
    <form onSubmit={async event => { event.preventDefault(); setSaving(true); setError(''); try { await onSave(draft); } catch (error) { setError(error.message); } finally { setSaving(false); } }}>
      <label>Name<input autoFocus required maxLength={500} value={draft.title} onChange={event => setDraft({ ...draft, title: event.target.value })} /></label>
      <label>Description<textarea rows={8} maxLength={50000} value={draft.description || ''} onChange={event => setDraft({ ...draft, description: event.target.value, highlights: [] })} /></label>
      <button type="button" onClick={() => setViewer(null)}>Open text viewer</button>
      <label>Images (optional, up to 4)<input type="file" multiple accept="image/png,image/jpeg,image/webp,image/gif" disabled={uploading || saving} onChange={attach} /></label>
      <div className="task-attachments">{draft.images.map((image, index) => <div key={index}><button type="button" onClick={() => setViewer(index)}><img src={image.data} alt={image.name} /><span>{image.name}</span></button><button type="button" aria-label={'Remove ' + image.name} onClick={() => setDraft({ ...draft, images: draft.images.filter((_, position) => position !== index) })}>Remove</button></div>)}</div>
      {task.id && <label>Status<select value={draft.status} onChange={event => setDraft({ ...draft, status: event.target.value })}>{[['todo', 'To do'], ['progress', 'In progress'], ['blocked', 'Blocked'], ['done', 'Done']].map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>}
      {error && <p role="alert">{error}</p>}<div className="project-toolbar"><button disabled={saving || uploading} type="submit">{saving ? 'Evaluating PRD impact and model…' : 'Save task'}</button><button type="button" onClick={onClose}>Cancel</button></div>
    </form>
    {viewer !== undefined && <TaskViewer task={draft} onChange={setDraft} initialImage={viewer} onClose={() => setViewer(undefined)} />}
  </TaskModal>;
}
