import test from 'node:test';
import assert from 'node:assert/strict';
import { terminalUpdate } from './terminal-state.js';
test('terminal consumes ANSI chunks once and resets for new runs or missing history', () => {
  const first = terminalUpdate(null, { runId: 'a', output: '\x1b[31mRed', outputEnd: 8 });
  assert.equal(first.reset, true);
  assert.equal(first.text, '\x1b[31mRed');
  const second = terminalUpdate(first.cursor, { runId: 'a', output: '\x1b[31mRed\x1b[0m\rOK', outputEnd: 15 });
  assert.equal(second.reset, false);
  assert.equal(second.text, '\x1b[0m\rOK');
  assert.equal(terminalUpdate(second.cursor, { runId: 'a', output: '\x1b[31mRed\x1b[0m\rOK', outputEnd: 15 }).text, '');
  assert.equal(terminalUpdate(second.cursor, { runId: 'b', output: 'New', outputEnd: 3 }).reset, true);
  assert.equal(terminalUpdate(second.cursor, { runId: 'a', output: 'Tail', outputEnd: 200100 }).reset, true);
  const trimmed = terminalUpdate({ runId: 'a', end: 8 }, { runId: 'a', output: 'Red more', outputEnd: 13 });
  assert.equal(trimmed.reset, false); assert.equal(trimmed.text, ' more');
});
