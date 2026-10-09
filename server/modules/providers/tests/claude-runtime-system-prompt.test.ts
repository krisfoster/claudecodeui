import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ClaudeSessionsProvider } from '@/modules/providers/list/claude/claude-sessions.provider.js';
import { CLAUDE_PREDEFINED_MODELS } from '@/modules/providers/list/claude/claude-models.provider.js';
import { queryClaudeSDK } from '@/modules/providers/list/claude/claude-runtime.provider.js';
import type { NormalizedMessage, ProviderRuntimeContext } from '@/shared/types.js';

/**
 * The model has no built-in way to know that claudecodeui's chat UI renders
 * ```mermaid/```vega-lite/```d3 fences and GFM tables inline instead of as
 * plain text (see src/modules/chat/transcript/Markdown.tsx) — without being
 * told, it defaults to writing a standalone HTML file into the repo when
 * asked for a diagram or chart. queryClaudeSDK appends that context to every
 * session's system prompt via the SDK's `systemPrompt.append` field.
 */

const SESSION_ID = 'system-prompt-session';

test("every session's system prompt documents the chat UI's inline renderers", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'claude-runtime-system-prompt-'));
  let capturedOptions: Record<string, unknown> | undefined;

  const sessions = new ClaudeSessionsProvider({ getLiveRunStartTime: () => null });
  const context: ProviderRuntimeContext = {
    resolveProviderSessionId: () => null,
    resolveResumeModel: async () => undefined,
    getProviderModels: async () => CLAUDE_PREDEFINED_MODELS as never,
    normalizeMessage: (raw, sessionId) => sessions.normalizeMessage(raw, sessionId),
    isProviderInstalled: async () => true,
    createQuery: ({ options }) => {
      capturedOptions = options as Record<string, unknown>;
      // End the stream immediately; this test only inspects the options passed in.
      return Object.assign((async function* () {})(), {
        interrupt: async () => {},
        stopTask: async () => {},
      });
    },
  };

  const sent: NormalizedMessage[] = [];
  const writer = { send: (message: NormalizedMessage) => { sent.push(message); }, userId: null };

  try {
    await queryClaudeSDK('hello', { sessionId: SESSION_ID, cwd }, writer as never, context);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }

  assert.ok(capturedOptions, 'createQuery must have been reached with a real cwd');
  const systemPrompt = capturedOptions?.systemPrompt as { type: string; preset: string; append?: string };
  assert.equal(systemPrompt.type, 'preset');
  assert.equal(systemPrompt.preset, 'claude_code');
  assert.match(systemPrompt.append ?? '', /```mermaid/);
  assert.match(systemPrompt.append ?? '', /```vega-lite/);
  assert.match(systemPrompt.append ?? '', /```d3/);
  assert.match(systemPrompt.append ?? '', /standalone HTML file/);
});
