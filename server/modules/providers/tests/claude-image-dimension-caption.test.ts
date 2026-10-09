import assert from 'node:assert/strict';
import test from 'node:test';

import { ClaudeSessionsProvider } from '@/modules/providers/list/claude/claude-sessions.provider.js';

/**
 * When Read downscales a large image for the model, the Claude CLI injects a
 * standalone assistant turn whose entire content is a coordinate-mapping
 * caption for its own benefit, e.g.:
 *   [Image: original 2972x1440, displayed at 2000x969. Multiply coordinates
 *   by 1.49 to map to original image.]
 * Confirmed live against the CLI's own stream-json output for a Read of an
 * oversized PNG: this is not part of the tool_result and not something the
 * model wrote — the model's real reply always follows in a separate turn
 * right after. Left unfiltered, it rendered as a confusing standalone text
 * bubble in the transcript (both live and on reload, since it's persisted to
 * the session .jsonl like any other assistant turn).
 */

const SESSION_ID = 'image-caption-session';

test('the image-dimension caption is dropped from an array-content assistant turn', () => {
  const normalized = new ClaudeSessionsProvider().normalizeMessage({
    type: 'assistant',
    session_id: SESSION_ID,
    uuid: 'caption-turn',
    message: {
      role: 'assistant',
      content: [{
        type: 'text',
        text: '[Image: original 2972x1440, displayed at 2000x969. Multiply coordinates by 1.49 to map to original image.]',
      }],
    },
  }, SESSION_ID);

  assert.deepEqual(normalized, []);
});

test('the image-dimension caption is dropped from a plain-string assistant turn', () => {
  const normalized = new ClaudeSessionsProvider().normalizeMessage({
    type: 'assistant',
    session_id: SESSION_ID,
    uuid: 'caption-turn-string',
    message: {
      role: 'assistant',
      content: '[Image: original 512x512, displayed at 512x512. Multiply coordinates by 1 to map to original image.]',
    },
  }, SESSION_ID);

  assert.deepEqual(normalized, []);
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

test('text that merely mentions an image in passing is not mistaken for the caption', () => {
  const [normalized] = new ClaudeSessionsProvider().normalizeMessage({
    type: 'assistant',
    session_id: SESSION_ID,
    uuid: 'mentions-image',
    message: {
      role: 'assistant',
      content: [{
        type: 'text',
        text: 'The image is 2972x1440, shown at 2000x969 — a screenshot of the admin console.',
      }],
    },
  }, SESSION_ID);

  assert.equal(normalized?.kind, 'text');
});
