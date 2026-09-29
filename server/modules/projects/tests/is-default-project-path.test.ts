import assert from 'node:assert/strict';
import test from 'node:test';

import { isDefaultProjectPath } from '../services/projects-with-sessions-fetch.service.js';

test('matches when both sides are the same resolved path', () => {
  assert.equal(isDefaultProjectPath('/Users/kris/claude_work/KB', '/Users/kris/claude_work/KB'), true);
});

test('does not match a different path', () => {
  assert.equal(isDefaultProjectPath('/Users/kris/other', '/Users/kris/claude_work/KB'), false);
});

test('does not match when no default is configured', () => {
  assert.equal(isDefaultProjectPath('/Users/kris/claude_work/KB', null), false);
});

test('is insensitive to a trailing slash on either side', () => {
  assert.equal(isDefaultProjectPath('/Users/kris/claude_work/KB/', '/Users/kris/claude_work/KB'), true);
});
