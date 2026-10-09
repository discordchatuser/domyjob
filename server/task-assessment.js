import { selectWithJev } from './jev.js';
import { loadRoutingSkill } from './model-route.js';

export function assessmentCandidates(task, existing, limit = 24) {
  const words = new Set((task.title + ' ' + (task.description || '')).toLowerCase().match(/[a-z0-9]{3,}/g) || []);
  const score = item => [...new Set((item.title + ' ' + (item.description || '')).toLowerCase().match(/[a-z0-9]{3,}/g) || [])].filter(word => words.has(word)).length;
  return existing.filter(item => item.id !== task.id).map((item, index) => ({ item, index, score: score(item) })).sort((a, b) => b.score - a.score || b.index - a.index).slice(0, limit).map(({ item }) => ({ id: item.id, title: item.title, description: (item.description || '').slice(0, 1500), status: item.status }));
}
export async function assessTask({ task, content, existing, getCodex, reportUsage, select = selectWithJev }) {
  try {
    const codex = await getCodex();
    const available = await codex.getModels();
    const route = await select({ task: (task.title + '\n' + (task.description || '')).slice(0, 65536), available, skill: await loadRoutingSkill(), pinnedModel: codex.model, reportUsage, usageContext: { project: content.cwd }, projectState: {
      requirements: [...content.requirements, ...(content.productContext || [])].slice(0, 4).map(item => ({ path: item.path, text: item.text.slice(0, 20000) })),
      tasks: assessmentCandidates(task, existing), totalTasks: existing.filter(item => item.id !== task.id).length,
    } });
    if (!route.assessment) return { status: 'pending', impact: 'unknown', relationships: [], warning: route.warning || 'PRD impact has not been evaluated.', route, evaluatedAt: new Date().toISOString() };
    return { ...route.assessment, status: 'evaluated', route, evaluatedAt: new Date().toISOString(), requirementPaths: content.requirements.map(item => item.path) };
  } catch {
    return { status: 'pending', impact: 'unknown', relationships: [], warning: 'Task saved. Model discovery or JEV assessment is unavailable; re-evaluate before execution.', evaluatedAt: new Date().toISOString() };
  }
}
