import assert from 'node:assert/strict';
import test from 'node:test';

import { ClaudeSessionsProvider } from '@/modules/providers/list/claude/claude-sessions.provider.js';

/**
 * When Read downscales a large image for the model, the Claude Agent SDK
 * injects a standalone, synthetic **user**-role turn whose entire content is
 * a coordinate-mapping caption for the model's own benefit, e.g.:
 *   [Image: original 2972x1440, displayed at 2000x969. Multiply coordinates
 *   by 1.49 to map to original image.]
 * Confirmed live against the SDK's own message stream for a Read of an
 * oversized PNG: it arrives as `{ type: 'user', message: { role: 'user',
 * content: [{ type: 'text', text: '...' }] }, isSynthetic: true }` — not part
 * of the tool_result, and not something a human typed. The model's real
 * reply always follows in a separate assistant turn right after. Left
 * unfiltered, this rendered as a confusing user-attributed text bubble, both
 * live and on reload (it's persisted to the session .jsonl like any other
 * turn).
 *
 * An earlier version of this fix wrongly assumed the caption was an
 * assistant-role message and filtered the wrong branch entirely — this suite
 * exercises the actual shape confirmed by live reproduction.
 */

const SESSION_ID = 'image-caption-session';

test('a synthetic image-dimension caption user turn produces no visible message', () => {
  const normalized = new ClaudeSessionsProvider().normalizeMessage({
    type: 'user',
    session_id: SESSION_ID,
    uuid: 'caption-turn',
    isSynthetic: true,
    message: {
      role: 'user',
      content: [{
        type: 'text',
        text: '[Image: original 2972x1440, displayed at 2000x969. Multiply coordinates by 1.49 to map to original image.]',
      }],
    },
  }, SESSION_ID);

  assert.deepEqual(normalized, []);
});

test('the same caption text WITHOUT isSynthetic is treated as real user content', () => {
  // A human could, in principle, type this exact string — only drop it when
  // the SDK itself marks the turn as synthetic.
  const [normalized] = new ClaudeSessionsProvider().normalizeMessage({
    type: 'user',
    session_id: SESSION_ID,
    uuid: 'not-synthetic',
    message: {
      role: 'user',
      content: [{
        type: 'text',
        text: '[Image: original 2972x1440, displayed at 2000x969. Multiply coordinates by 1.49 to map to original image.]',
      }],
    },
  }, SESSION_ID);

  assert.equal(normalized?.kind, 'text');
  assert.equal(normalized?.role, 'user');
});

test("a real synthetic user turn with different text is not mistaken for the caption", () => {
  const [normalized] = new ClaudeSessionsProvider().normalizeMessage({
    type: 'user',
    session_id: SESSION_ID,
    uuid: 'other-synthetic',
    isSynthetic: true,
    message: {
      role: 'user',
      content: [{ type: 'text', text: 'Please continue.' }],
    },
  }, SESSION_ID);

  assert.equal(normalized?.kind, 'text');
  assert.equal(normalized?.content, 'Please continue.');
});

test("the model's real description right after the caption still comes through", () => {
  const [normalized] = new ClaudeSessionsProvider().normalizeMessage({
    type: 'assistant',
    session_id: SESSION_ID,
    uuid: 'real-reply',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: "It's the Claude Code logo: a coral-orange starburst." }],
    },
  }, SESSION_ID);

  assert.equal(normalized?.kind, 'text');
  assert.equal(normalized?.content, "It's the Claude Code logo: a coral-orange starburst.");
});
