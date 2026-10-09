import React, { useState } from 'react';

const short = (value, length = 34) => (value || '').length > length ? value.slice(0, length - 1) + '…' : value || '';
export function TaskGraph({ tasks, audit = [], onSelect }) {
  const [focus, setFocus] = useState('');
  const [filter, setFilter] = useState('');
  const visible = tasks.filter(task => !filter || task.status === filter).slice(0, 100);
  const positions = new Map(visible.map((task, index) => [task.id, 65 + index * 150]));
  const selected = tasks.find(task => task.id === focus);
  const relations = visible.flatMap(task => (task.assessment?.relationships || []).filter(link => positions.has(link.taskId)).map(link => ({ ...link, from: task.id })));
  const activate = task => { setFocus(task.id); };
  function node(task, x, title, subtitle, kind) {
    const y = positions.get(task.id);
    return <g key={kind} className={'graph-node ' + task.status} role="button" tabIndex={0} aria-label={`${task.title}: ${title}, ${subtitle}`} onClick={() => activate(task)} onKeyDown={event => { if (['Enter', ' '].includes(event.key)) { event.preventDefault(); activate(task); } }}>
      <title>{title + '\n' + subtitle}</title><rect x={x} y={y - 28} width={260} height={70} rx={10} /><text x={x + 14} y={y - 2}>{short(title)}</text><text className="graph-subtitle" x={x + 14} y={y + 23}>{short(subtitle, 38)}</text>
    </g>;
  }
  return <section className="task-graph" aria-label="Task relationship graph"><div className="project-toolbar"><div><h2>Task graph</h2></div><select aria-label="Filter task graph" value={filter} onChange={event => setFilter(event.target.value)}><option value="">All statuses</option>{['todo', 'progress', 'blocked', 'done'].map(value => <option key={value}>{value}</option>)}</select></div>
    <details className="graph-help"><summary>About this graph</summary><p>Links show assessed task relationships. Select a node for its requirements, model and execution history.</p></details>
    {!visible.length ? <p>No tasks to display.</p> : <div className="task-graph-scroll"><svg width="1160" height={Math.max(220, visible.length * 150 + 50)} role="group" aria-label="Tasks, requirement changes and executions">
      <defs><marker id="task-graph-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" /></marker></defs>
      <text x="200" y="22">Tasks</text><text x="510" y="22">PRD impact · chosen model</text><text x="820" y="22">Execution</text>
      {relations.map((link, index) => { const from = positions.get(link.from), to = positions.get(link.taskId), bend = 25 + index % 8 * 18; return <g key={link.from + ':' + link.taskId}><path className="graph-edge" markerEnd="url(#task-graph-arrow)" d={`M 200 ${from} C ${bend} ${from}, ${bend} ${to}, 200 ${to}`} /><text className="graph-link-label" x={bend} y={(from + to) / 2}>{link.type.replaceAll('_', ' ')}</text><title>{link.type + ' · confidence ' + Math.round(link.confidence * 100) + '%'}</title></g>; })}
      {visible.map(task => { const y = positions.get(task.id), assessment = task.assessment, run = task.execution; return <g key={task.id}>
        <path className="graph-edge" markerEnd="url(#task-graph-arrow)" d={`M 460 ${y} L 510 ${y}`} /><path className="graph-edge" markerEnd="url(#task-graph-arrow)" d={`M 770 ${y} L 820 ${y}`} />
        {node(task, 200, task.title, `${task.status} · ${task.phase}`, 'task')}
        {node(task, 510, assessment ? `${assessment.impact} · ${assessment.needsClarification ? 'needs clarification' : assessment.status}` : 'Not evaluated', assessment?.route?.model || 'Model selection pending', 'assessment')}
        {node(task, 820, run ? run.status : 'Not started', run ? `${task.executions?.length || 1} run(s) · ${run.route?.model || 'routing'}` : 'Run task to begin', 'execution')}
      </g>; })}
    </svg></div>}
    {tasks.filter(task => !filter || task.status === filter).length > 100 && <p>Showing the first 100 tasks. Filter by status to narrow the graph.</p>}
    {selected && <div className="graph-details"><div className="project-toolbar"><h3>{selected.title}</h3><button onClick={() => onSelect(selected)}>Open task</button><button onClick={() => setFocus('')}>Close graph details</button></div>
      <p>{selected.description}</p><p>PRD impact: {selected.assessment?.impact || 'not evaluated'} · {selected.assessment?.prdPath || 'No PRD record yet'}</p>
      {(selected.assessment?.relationships || []).map(link => <p key={link.taskId}>{link.type.replaceAll('_', ' ')}: <button onClick={() => { const target = tasks.find(task => task.id === link.taskId); if (target) activate(target); }} disabled={!tasks.some(task => task.id === link.taskId)}>{tasks.find(task => task.id === link.taskId)?.title || 'Deleted task'}</button> · {Math.round(link.confidence * 100)}% confidence</p>)}
      {(selected.executions || (selected.execution ? [selected.execution] : [])).map((run, index) => <details key={run.id || index} open={index === (selected.executions?.length || 1) - 1}><summary>{run.status} · {run.route?.model || 'Model pending'} · {new Date(run.startedAt || run.updatedAt).toLocaleString()}</summary>{run.route && <p>{run.route.reason} · {run.route.source}</p>}{run.error && <p role="alert">{run.error}</p>}<pre>{run.outcome || 'No final report recorded.'}</pre></details>)}
      <details><summary>Task audit trail</summary>{audit.filter(entry => entry.taskId === selected.id).map(entry => <p key={entry.id}>{new Date(entry.at).toLocaleString()} · {entry.action}</p>)}</details>
    </div>}
  </section>;
}
