import { imageType } from './images.js';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

export async function taskStore(dataDir) {
  const file = resolve(dataDir, 'project-tasks.json');
  let projects;
  try { projects = JSON.parse(await readFile(file, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; projects = {}; }
  let queue = Promise.resolve();
  const project = cwd => projects[cwd] ||= { tasks: {}, audit: [] };
  const save = () => { const snapshot = JSON.stringify(projects); queue = queue.catch(() => {}).then(async () => { await writeFile(file + '.tmp', snapshot); await rename(file + '.tmp', file); }); return queue; };
  const merged = (cwd, imported) => {
    const records = project(cwd).tasks;
    return [...imported.filter(task => !records[task.id]?.deleted).map(task => ({ ...task, ...records[task.id] })), ...Object.values(records).filter(task => !task.deleted && !imported.some(item => item.id === task.id))];
  };
  async function record(cwd, action, task, details = {}) {
    project(cwd).audit.unshift({ id: randomUUID(), at: new Date().toISOString(), action, taskId: task.id, title: task.title, ...details });
    await save();
  }
  // An interrupted process must never leave a task permanently locked.
  for (const [cwd, value] of Object.entries(projects)) for (const task of Object.values(value.tasks)) if (task.execution?.status === 'running') {
    task.execution.status = 'interrupted'; task.status = 'blocked';
    await record(cwd, 'execution.interrupted', task);
  }
  return {
    merged, audit: cwd => project(cwd).audit,
    async update(cwd, imported, id, input, deleting = false) {
      const old = id ? merged(cwd, imported).find(task => task.id === id) : null;
      if (id && !old) throw new Error('Task not found');
      if (old?.execution?.status === 'running') throw new Error('Task is running');
      const changed = !old || ['title', 'description'].some(key => input[key] !== undefined && input[key] !== old[key]);
      const task = { ...(old || { id: randomUUID(), phase: 'Project', docs: [], source: '', status: 'todo' }), ...input };
      if (typeof task.title !== 'string' || !task.title.trim() || task.title.length > 500 || (task.description !== undefined && (typeof task.description !== 'string' || task.description.length > 50000)) || !['todo', 'progress', 'blocked', 'done'].includes(task.status)) throw new Error('Enter a title, description and valid task status');
      if (!Array.isArray(task.images || []) || (task.images || []).length > 4) throw new Error('Attach up to four images');
      for (const image of task.images || []) {
        if (typeof image.name !== 'string' || image.name.length > 500 || typeof image.data !== 'string' || !/^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(image.data) || image.data.length > 2800000) throw new Error('Invalid image attachment');
        const bytes = Buffer.from(image.data.split(',')[1], 'base64');
        const type = imageType(bytes);
        if (bytes.length > 2 * 1024 * 1024 || !image.data.startsWith('data:image/' + (type === 'jpg' ? 'jpeg' : type) + ';')) throw new Error('Invalid image attachment');
        if (!Array.isArray(image.marks || []) || (image.marks || []).length > 200 || (image.marks || []).some(mark => !mark || ['x', 'y', 'width', 'height'].some(key => typeof mark[key] !== 'number' || !Number.isFinite(mark[key]) || mark[key] < 0 || mark[key] > 1) || mark.x + mark.width > 1.000001 || mark.y + mark.height > 1.000001)) throw new Error('Invalid image marks');
      }
      if (!Array.isArray(task.highlights || []) || (task.highlights || []).length > 200) throw new Error('Invalid text highlights');
      let end = 0;
      for (const mark of task.highlights || []) {
        if (!mark || !Number.isInteger(mark.start) || !Number.isInteger(mark.end) || mark.start < end || mark.end <= mark.start || mark.end > (task.description || '').length) throw new Error('Invalid text highlights');
        end = mark.end;
      }
      if (changed) { task.assessment = { status: 'pending', impact: 'unknown', relationships: [], ...(old?.assessment?.prdPath ? { prdPath: old.assessment.prdPath } : {}), warning: 'Task requires impact evaluation.' }; task.revision = (old?.revision || 0) + 1; }
      task.title = task.title.trim(); task.deleted = deleting;
      project(cwd).tasks[task.id] = task;
      await record(cwd, deleting ? 'task.deleted' : old ? 'task.updated' : 'task.created', task);
      return task;
    },
    async assess(cwd, task, assessment) {
      const current = project(cwd).tasks[task.id] || task;
      if (!current || current.deleted || current.revision !== task.revision) return current;
      const next = { ...current, assessment };
      project(cwd).tasks[task.id] = next;
      await record(cwd, 'task.assessed', next, { assessment });
      return next;
    },
    async execution(cwd, task, status, details = {}) {
      const next = { ...task, status: status === 'running' ? 'progress' : status === 'completed' ? 'done' : 'blocked', execution: { ...task.execution, ...details, status, updatedAt: new Date().toISOString() } };
      if (status === 'running') { next.execution.id = randomUUID(); next.execution.outcome = undefined; }
      next.executions = [...(task.executions || []).filter(run => run.id !== next.execution.id), { ...next.execution }];
      project(cwd).tasks[task.id] = next;
      await record(cwd, 'execution.' + status, next, details);
      return next;
    }, record,
  };
}
