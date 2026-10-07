// Support older chats that stored shell output as plain assistant text.
export function activityFromMessage(item) {
  if (item.role === 'tool' || item.role === 'activity') return item;
  if (item.role !== 'assistant' || !item.text?.startsWith('$ ')) return null;
  const lines = item.text.split('\n');
  const exit = lines.at(-1)?.match(/^Exit code: (-?\d+)$/);
  return { role: 'tool', command: lines[0].slice(2), output: lines.slice(1, exit ? -1 : undefined).join('\n'), exitCode: exit ? Number(exit[1]) : null, status: exit ? 'completed' : 'unknown' };
}
export function outputPreview(output = '') {
  const lines = output.split('\n').filter(line => line.trim());
  return { text: lines.slice(0, 3).map(line => line.length > 150 ? line.slice(0, 150) + '…' : line).join('\n'), more: lines.length > 3 || lines.slice(0, 3).some(line => line.length > 150) };
}
