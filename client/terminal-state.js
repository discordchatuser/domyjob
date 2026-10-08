// Absolute output positions avoid replaying escape sequences on each poll.
export function terminalUpdate(previous, server) {
  const output = server.output || '';
  const end = server.outputEnd ?? output.length;
  const start = end - output.length;
  const reset = !previous || previous.runId !== server.runId || previous.end < start || previous.end > end;
  return { reset, text: reset ? output : output.slice(previous.end - start), cursor: { runId: server.runId, end } };
}
