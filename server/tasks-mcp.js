import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const project = { type: 'string', minLength: 1, maxLength: 4096, description: 'Absolute path of the current project supplied by the orchestrator.' };
const title = { type: 'string', minLength: 1, maxLength: 500 };
const description = { type: 'string', maxLength: 50000, description: 'Concise desired behavior, scope, and observable completion criteria.' };
export const projectTaskTools = [
  { annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, name: 'list_tasks', description: 'Read the current project task board before creating or amending tasks. Returns task IDs, descriptions, statuses and impact assessments.', inputSchema: { type: 'object', additionalProperties: false, required: ['project'], properties: { project } } },
  { annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }, name: 'create_task', description: 'Save a task through the application task system, including JEV model/PRD impact evaluation, relationships, PRD change recording and project audit log. Creates a To do task; does not execute it.', inputSchema: { type: 'object', additionalProperties: false, required: ['project', 'title', 'description'], properties: { project, title, description } } },
  { annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }, name: 'update_task', description: 'Amend an existing application task by ID. Changes to its definition go through the same JEV and PRD evaluation as the task editor.', inputSchema: { type: 'object', additionalProperties: false, required: ['project', 'id'], properties: { project, id: { type: 'string', minLength: 1, maxLength: 4096 }, title, description } } },
];
const compact = task => ({ id: task.id, title: task.title, description: task.description || '', status: task.status, assessment: task.assessment, execution: task.execution ? { status: task.execution.status, updatedAt: task.execution.updatedAt } : undefined });
export async function handleTaskMcp(message, { fetchImpl = fetch, baseUrl = 'http://127.0.0.1:3001' } = {}) {
  if (message.id === undefined) return null;
  const result = value => ({ jsonrpc: '2.0', id: message.id, result: value });
  if (message.method === 'initialize') return result({ protocolVersion: message.params?.protocolVersion || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'project-tasks', version: '1.0.0' } });
  if (message.method === 'ping') return result({});
  if (message.method === 'tools/list') return result({ tools: projectTaskTools });
  if (message.method !== 'tools/call') return { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } };
  const tool = projectTaskTools.find(tool => tool.name === message.params?.name);
  if (!tool) return result({ isError: true, content: [{ type: 'text', text: 'Unknown project task tool' }] });
  try {
    const args = message.params.arguments;
    const fields = tool.inputSchema.properties;
    if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(key => !Object.hasOwn(fields, key)) || tool.inputSchema.required.some(key => args[key] === undefined)) throw new Error('Invalid task arguments');
    for (const [key, value] of Object.entries(args)) {
      const schema = fields[key];
      if (typeof value !== 'string' || value.length > schema.maxLength || (schema.minLength && !value.trim())) throw new Error('Invalid task ' + key);
    }
    if (!args.project.startsWith('/') || args.project.includes('\0')) throw new Error('Use the current project absolute path');
    if (tool.name === 'update_task' && args.title === undefined && args.description === undefined) throw new Error('Supply a title or description to update');
    const listing = tool.name === 'list_tasks';
    const { project: cwd, ...changes } = args;
    let response;
    try {
      response = await fetchImpl(baseUrl + (listing ? '/api/project/content?path=' + encodeURIComponent(cwd) : '/api/project/tasks'), { signal: AbortSignal.timeout(60000), ...(listing ? {} : { method: tool.name === 'create_task' ? 'POST' : 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cwd, ...changes }) }) });
    } catch { throw new Error('Task service unavailable or timed out. A write may already have succeeded. List tasks before retrying.'); }
    const body = await response.json();
    if (!response.ok) throw new Error(typeof body.error === 'string' ? body.error.slice(0, 500) : 'Task request failed');
    return result({ content: [{ type: 'text', text: JSON.stringify(listing ? { project: body.cwd, tasks: body.tasks.map(compact) } : { task: compact(body), saved: true }) }] });
  } catch (error) {
    return result({ isError: true, content: [{ type: 'text', text: error.message }] });
  }
}
if (resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  createInterface({ input: process.stdin }).on('line', async line => {
    try { const response = await handleTaskMcp(JSON.parse(line)); if (response) process.stdout.write(JSON.stringify(response) + '\n'); }
    catch { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }) + '\n'); }
  });
}
