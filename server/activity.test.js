import test from 'node:test';
import assert from 'node:assert/strict';
import { activityFromMessage, outputPreview } from '../client/activity.js';

test('old command transcripts become collapsible activities without losing output', () => {
  const activity = activityFromMessage({ role: 'assistant', text: '$ ls -la\na\nb\nExit code: 0' });
  assert.equal(activity.command, 'ls -la');
  assert.equal(activity.output, 'a\nb');
  assert.equal(activity.exitCode, 0);
  assert.equal(activityFromMessage({ role: 'assistant', text: 'Normal reply' }), null);
});

test('command previews are bounded while full output is retained separately', () => {
  const full = 'x'.repeat(500) + '\na\nb\nc\nd';
  const preview = outputPreview(full);
  assert.equal(preview.text.split('\n').length, 3);
  assert.equal(preview.text.split('\n')[0].length, 151);
  assert.equal(preview.more, true);
});
