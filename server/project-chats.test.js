import test from 'node:test';
import assert from 'node:assert/strict';
import { migrateProjectChats, projectOrchestrator } from './project-chats.js';
test('adopts oldest project conversation without losing history and keeps selection stable', () => {
  const chats = [
    { id: 'newer', cwd: '/project', messages: [{ text: 'Newer work' }] },
    { id: 'general', messages: [] },
    { id: 'original', cwd: '/project', threadId: 'codex-original', messages: [{ text: 'Project context' }] },
  ];
  assert.equal(migrateProjectChats(chats), true);
  assert.equal(projectOrchestrator(chats, '/project').id, 'original');
  assert.equal(chats[0].archivedProjectThread, true);
  assert.equal(chats[2].orchestrator, true);
  assert.equal(chats[2].threadId, 'codex-original');
  assert.equal(chats[0].messages[0].text, 'Newer work');
  assert.equal(chats[1].orchestrator, undefined);
  assert.equal(migrateProjectChats(chats), false);
  assert.equal(projectOrchestrator(JSON.parse(JSON.stringify(chats)), '/project').id, 'original');
});
