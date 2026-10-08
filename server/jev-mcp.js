// Small stdio MCP tool: available to existing orchestrators and their subagents.
import './env.js';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { readFile } from 'node:fs/promises';
import { loadRoutingSkill } from './model-route.js';
import { usageStore } from './usage.js';
import { selectWithJev } from './jev.js';
export const chooseModelTool = {
  name: 'choose_model', description: 'Use JEV to choose an available Codex model for a bounded task before spawning a subagent. Returns model, difficulty, confidence and any fallback warning.',
  inputSchema: { type: 'object', required: ['task'], additionalProperties: false, properties: { task: { type: 'string', minLength: 1, maxLength: 65536 }, context: { type: 'string', maxLength: 12000 }, project: { type: 'string', maxLength: 4096 } } },
};
export async function handleMcp(message, route) {
  if (message.id === undefined) return null;
  const result = value => ({ jsonrpc: '2.0', id: message.id, result: value });
  if (message.method === 'initialize') return result({ protocolVersion: message.params?.protocolVersion || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'jev-model-router', version: '1.0.0' } });
  if (message.method === 'ping') return result({});
  if (message.method === 'tools/list') return result({ tools: [chooseModelTool] });
  if (message.method === 'tools/call') {
    if (message.params?.name !== 'choose_model') return result({ isError: true, content: [{ type: 'text', text: 'Unknown tool' }] });
    try {
      const args = message.params.arguments;
      if (typeof args?.task !== 'string' || !args.task.trim() || args.task.length > 65536 || (args.context !== undefined && (typeof args.context !== 'string' || args.context.length > 12000))) throw new Error('Invalid task');
      return result({ content: [{ type: 'text', text: JSON.stringify(await route(args)) }] });
    } catch { return result({ isError: true, content: [{ type: 'text', text: 'Could not select a model. Check backend model discovery and JEV configuration.' }] }); }
  }
  return { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } };
}
if (resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  const catalogPath = process.argv[2];
  const store = usageStore(resolve(catalogPath, '..'));
  const route = async ({ task, context, project }) => selectWithJev({ task, context, reportUsage: store.record, usageContext: { project: typeof project === 'string' ? project : '' }, available: JSON.parse(await readFile(catalogPath, 'utf8')), skill: await loadRoutingSkill(), pinnedModel: process.env.CODEX_MODEL });
  createInterface({ input: process.stdin }).on('line', async line => {
    try { const response = await handleMcp(JSON.parse(line), route); if (response) process.stdout.write(JSON.stringify(response) + '\n'); }
    catch { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }) + '\n'); }
  });
}
