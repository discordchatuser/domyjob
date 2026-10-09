import { readFile, writeFile, rename, realpath, stat } from 'node:fs/promises';
import { resolve, relative, sep } from 'node:path';

const queues = new Map();
// Record requested changes immediately; the executor reconciles the original requirement text.
export function syncTaskPrd(cwd, path, tasks) {
  const previous = queues.get(cwd) || Promise.resolve();
  const next = previous.catch(() => {}).then(async () => {
    const root = await realpath(cwd);
    const target = resolve(root, path || 'PRD.md');
    const targetRelative = relative(root, target);
    if (!targetRelative || targetRelative === '..' || targetRelative.startsWith('..' + sep) || targetRelative.startsWith(sep)) throw new Error('PRD is outside this project');
    let file = target, original = '';
    try {
      file = await realpath(target);
      const rel = relative(root, file);
      if (rel === '..' || rel.startsWith('..' + sep) || rel.startsWith(sep)) throw new Error('PRD is outside this project');
      if ((await stat(file)).size > 2 * 1024 * 1024) throw new Error('PRD exceeds 2 MB');
      original = await readFile(file, 'utf8');
    } catch (error) { if (error.code !== 'ENOENT') throw error; original = '# Product requirements\n'; }
    const start = '<!-- project-task-changes:start -->', end = '<!-- project-task-changes:end -->';
    const a = original.indexOf(start), b = original.indexOf(end);
    if ((a >= 0) !== (b >= 0) || (a >= 0 && b < a)) throw new Error('Repair the task change section markers before syncing the PRD');
    const clean = value => String(value || '').replace(/<!--/g, '&lt;!--');
    const entries = tasks.filter(task => task.assessment && task.assessment.impact !== 'none').map(task => `### ${clean(task.title)}\n\nTask ID: ${task.id}\n\nRequested impact: ${task.assessment.impact}\n\nTask status: ${task.status}; execution: ${task.execution?.status || 'not started'}${task.assessment.needsClarification ? '; clarification required' : ''}\n\n${clean(task.description)}\n`);
    const block = start + '\n## Task-driven requirement changes\n\nThese are requested product changes. Task completion and execution evidence are tracked separately. Reconcile these requests with the existing requirements during implementation.\n\n' + (entries.join('\n') || 'No outstanding product change requests.\n') + end;
    const updated = a >= 0 ? original.slice(0, a) + block + original.slice(b + end.length) : original.trimEnd() + '\n\n' + block + '\n';
    await writeFile(file + '.tasks.tmp', updated); await rename(file + '.tasks.tmp', file);
    return relative(root, file).split(sep).join('/');
  });
  queues.set(cwd, next);
  next.finally(() => { if (queues.get(cwd) === next) queues.delete(cwd); }).catch(() => {});
  return next;
}
