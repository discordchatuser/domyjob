// Chats are stored newest first. Keep a stable, original conversation per project.
export function projectOrchestrator(chats, cwd) {
  return chats.find(chat => chat.cwd === cwd && chat.orchestrator) || chats.findLast(chat => chat.cwd === cwd);
}
export function migrateProjectChats(chats) {
  let changed = false;
  for (const cwd of new Set(chats.map(chat => chat.cwd).filter(Boolean))) {
    const primary = projectOrchestrator(chats, cwd);
    for (const chat of chats.filter(chat => chat.cwd === cwd)) {
      const orchestrator = chat === primary;
      if (chat.orchestrator !== orchestrator || chat.archivedProjectThread !== !orchestrator) changed = true;
      chat.orchestrator = orchestrator;
      chat.archivedProjectThread = !orchestrator;
    }
  }
  return changed;
}
