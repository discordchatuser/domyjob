import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { resolve, relative, extname, dirname, basename, sep } from 'node:path';
import { projectInfo } from './projects.js';

const skipped = new Set(['.git', 'node_modules', 'vendor', 'dist', 'build', '.data', '.next', 'coverage']);
export async function readDocument(root, path) {
  if (typeof path !== 'string' || !['.md', '.pdf'].includes(extname(path).toLowerCase())) throw new Error('Select a Markdown or PDF document');
  const cwd = (await projectInfo(root)).cwd;
  const file = await realpath(resolve(cwd, path));
  const rel = relative(cwd, file);
  if (rel.startsWith('..' + sep) || rel === '..' || resolve(file) === cwd || rel.startsWith(sep)) throw new Error('Document is outside this project');
  const info = await stat(file);
  if (!info.isFile() || info.size > 30 * 1024 * 1024) throw new Error('Document must be a file smaller than 30 MB');
  return { bytes: await readFile(file), type: extname(path).toLowerCase() === '.pdf' ? 'application/pdf' : 'text/plain; charset=utf-8' };
}
const field = (text, name) => text.match(new RegExp('^' + name + ':\\s*["\']?([^\\n"\']+)', 'm'))?.[1]?.trim();
const tag = (text, name) => text.match(new RegExp('<' + name + '>([\\s\\S]*?)</' + name + '>'))?.[1]?.trim() || '';

export function parseTasks(documents, texts) {
  const tasks = [];
  const plans = documents.filter(doc => /(?:^|\/)\d+(?:-\d+)?-PLAN\.md$/i.test(doc.path));
  for (const plan of plans) {
    const text = texts.get(plan.path) || '';
    const summaryPath = plan.path.replace(/-PLAN\.md$/i, '-SUMMARY.md');
    const summary = texts.get(summaryPath) || '';
    const complete = field(summary, 'status') === 'complete';
    const count = Number(summary.match(/tasks_completed:\s*(\d+)/)?.[1] || 0);
    const checkpoint = summary.match(/checkpoint:[^\n]*task:\s*([\w-]+)/)?.[1];
    const phase = field(text, 'phase') || basename(dirname(plan.path));
    const blocks = [...text.matchAll(/<task\b([^>]*)>([\s\S]*?)<\/task>/g)];
    if (!blocks.length) tasks.push({ id: plan.path, title: tag(text, 'objective') || basename(plan.path), phase, status: complete ? 'done' : summary ? 'progress' : 'todo', source: plan.path, docs: [plan.path, ...(summary ? [summaryPath] : [])] });
    blocks.forEach((match, index) => {
      const title = tag(match[2], 'name') || `Task ${index + 1}`;
      const id = title.match(/^([\d-]+)/)?.[1] || `${plan.path}:${index}`;
      const blocked = !complete && (checkpoint ? id === checkpoint : /checkpoint/.test(match[1]) && /halted|blocked|pending/i.test(field(summary, 'status') || ''));
      const status = complete || index < count ? 'done' : blocked ? 'blocked' : summary ? 'progress' : 'todo';
      const linked = [plan.path, ...(summary ? [summaryPath] : [])];
      for (const doc of documents) if (doc.path !== plan.path && doc.path !== summaryPath && (match[2].includes(doc.path) || (dirname(doc.path) === dirname(plan.path) && /(?:CONTEXT|RESEARCH|USER-SETUP|VALIDATION)\.md$/.test(doc.path)))) linked.push(doc.path);
      tasks.push({ id: `${plan.path}:${id}`, title, phase, status, description: tag(match[2], 'done') || tag(match[2], 'action'), source: plan.path, docs: linked });
    });
  }
  for (const doc of documents.filter(doc => /(?:ROADMAP|TASKS|TODO|BACKLOG)\.md$/i.test(doc.path))) {
    const text = texts.get(doc.path) || '';
    for (const [index, match] of [...text.matchAll(/^\s*[-*]\s+\[([ xX])\]\s+(.+)$/gm)].entries()) {
      const title = match[2].replace(/\*\*/g, '');
      if (/PLAN\.md/i.test(title)) continue;
      if (/^Phase\s+(\d+)/i.test(title)) {
        const number = Number(title.match(/^Phase\s+(\d+)/i)[1]);
        if (tasks.some(task => Number(task.phase.match(/^\d+/)?.[0]) === number)) continue;
      }
      tasks.push({ id: `${doc.path}:${index}`, title, phase: 'Roadmap', status: match[1].toLowerCase() === 'x' ? 'done' : 'todo', source: doc.path, docs: [doc.path] });
    }
  }
  return tasks;
}

export async function projectContent(root) {
  const project = await projectInfo(root);
  const documents = [], texts = new Map(), warnings = [];
  let visited = 0;
  async function walk(folder, depth = 0) {
    if (depth > 12 || visited > 10000 || documents.length >= 1500) { if (!warnings.length) warnings.push('Large project: document scan limited to 1,500 documents, 10,000 entries and 12 folder levels.'); return; }
    let entries;
    try { entries = await readdir(folder, { withFileTypes: true }); } catch { warnings.push('Could not read ' + relative(project.cwd, folder)); return; }
    for (const entry of entries) {
      visited++;
      if (skipped.has(entry.name) || entry.isSymbolicLink()) continue;
      const file = resolve(folder, entry.name);
      if (entry.isDirectory()) await walk(file, depth + 1);
      else if (entry.isFile() && /\.(md|pdf)$/i.test(entry.name) && documents.length < 1500) {
        const path = relative(project.cwd, file).split(sep).join('/');
        documents.push({ path, name: entry.name, type: extname(file).slice(1).toLowerCase() });
        if (/\.md$/i.test(file) && (await stat(file)).size < 2 * 1024 * 1024) texts.set(path, await readFile(file, 'utf8'));
      }
    }
  }
  await walk(project.cwd);
  documents.sort((a, b) => a.path.localeCompare(b.path));
  return { ...project, documents, tasks: parseTasks(documents, texts), warnings };
}
