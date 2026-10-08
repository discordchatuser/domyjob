import { readFile } from 'node:fs/promises';

export const routingSkillPath = new URL('../skills/model-route/SKILL.md', import.meta.url);

export async function loadRoutingSkill(path = routingSkillPath) {
  const instructions = await readFile(path, 'utf8');
  const models = {};
  for (const [, tier, model] of instructions.matchAll(/^\|\s*(easy|medium|hard)\s*\|\s*`([^`]+)`/gm)) models[tier] = model;
  if (!['easy', 'medium', 'hard'].every(tier => models[tier])) throw new Error('model-route skill must define easy, medium, and hard models.');
  return { instructions, models };
}
