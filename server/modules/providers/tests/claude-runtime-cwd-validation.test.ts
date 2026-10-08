import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { ClaudeSessionsProvider } from '@/modules/providers/list/claude/claude-sessions.provider.js';
import { CLAUDE_PREDEFINED_MODELS } from '@/modules/providers/list/claude/claude-models.provider.js';
import { queryClaudeSDK } from '@/modules/providers/list/claude/claude-runtime.provider.js';
import type { NormalizedMessage, ProviderRuntimeContext } from '@/shared/types.js';

/**
 * A project imported from host session history has a real cwd recorded on
 * its session, but that folder may never have been mounted into this
 * environment. Node's spawn() then fails with ENOENT against the missing
 * cwd, and the Claude Agent SDK's own error formatting misreports that as
 * "native binary ... exists but failed to launch" — it only checks that the
 * executable file exists, never the cwd. queryClaudeSDK checks cwd itself
 * first so the error actually says what's wrong, before ever reaching the
 * SDK/spawn.
 */

const SESSION_ID = 'cwd-validation-session';

function makeContext(): { context: ProviderRuntimeContext; queryWasCalled: () => boolean } {
  let queryWasCalled = false;
  const sessions = new ClaudeSessionsProvider({ getLiveRunStartTime: () => null });
  const context: ProviderRuntimeContext = {
    resolveProviderSessionId: () => null,
    resolveResumeModel: async () => undefined,
    getProviderModels: async () => CLAUDE_PREDEFINED_MODELS as never,
    normalizeMessage: (raw, sessionId) => sessions.normalizeMessage(raw, sessionId),
    isProviderInstalled: async () => true,
    createQuery: () => {
      queryWasCalled = true;
      // Should never run for a missing cwd — if it does, fail loudly rather
      // than hanging the test on an iterator nothing ever drives.
      throw new Error('createQuery should not be reached when cwd does not exist');
    },
  };
  return { context, queryWasCalled: () => queryWasCalled };
}

test('a cwd that does not exist fails with a clear error instead of reaching the SDK', async () => {
  const missingCwd = path.join('/nonexistent-ccui-test-path', 'definitely-not-here');
  const { context, queryWasCalled } = makeContext();
  const sent: NormalizedMessage[] = [];
  const writer = { send: (message: NormalizedMessage) => { sent.push(message); }, userId: null };

  await queryClaudeSDK('hello', { sessionId: SESSION_ID, cwd: missingCwd }, writer as never, context);

  assert.equal(queryWasCalled(), false, 'must not attempt to spawn against a cwd that does not exist');

  const errorMessage = sent.find((message) => message.kind === 'error');
  assert.ok(errorMessage, 'a clear error must be sent to the client');
  assert.match(String(errorMessage?.content), /isn't available in this environment/);
  assert.match(String(errorMessage?.content), new RegExp(missingCwd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(
    String(errorMessage?.content),
    /exists but failed to launch/,
    'must not surface the SDK\'s misleading message, which blames the binary instead of the missing cwd',
  );

  const completeMessage = sent.find((message) => message.kind === 'complete');
  assert.ok(completeMessage, 'a terminal complete must still be sent so the client stops waiting');
});

test('a cwd that is a file, not a directory, is treated the same as missing', async () => {
  const { context, queryWasCalled } = makeContext();
  const sent: NormalizedMessage[] = [];
  const writer = { send: (message: NormalizedMessage) => { sent.push(message); }, userId: null };

  // This test file itself is a real path but not a directory.
  const fileNotDirectory = import.meta.url.startsWith('file://')
    ? new URL(import.meta.url).pathname
    : __filename;

  await queryClaudeSDK('hello', { sessionId: SESSION_ID, cwd: fileNotDirectory }, writer as never, context);

  assert.equal(queryWasCalled(), false);
  const errorMessage = sent.find((message) => message.kind === 'error');
  assert.match(String(errorMessage?.content), /isn't available in this environment/);
});
