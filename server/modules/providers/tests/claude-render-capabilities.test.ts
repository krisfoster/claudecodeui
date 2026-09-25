import assert from 'node:assert/strict';
import test from 'node:test';

import { mapCliOptionsToSDK } from '@/modules/providers/list/claude/claude-runtime.provider.js';

// There is no client-capabilities handshake in the Agent SDK — appending to
// the system prompt is the only documented way to tell Claude what a client
// renders. Default on so existing sessions benefit without a settings
// migration; the composer's toggle opts out by sending `false` explicitly.
test('mapCliOptionsToSDK appends the render-capabilities hint by default', () => {
  const sdkOptions = mapCliOptionsToSDK({});

  assert.equal(sdkOptions.systemPrompt.type, 'preset');
  assert.equal(sdkOptions.systemPrompt.preset, 'claude_code');
  assert.match(sdkOptions.systemPrompt.append ?? '', /mermaid/i);
});

test('mapCliOptionsToSDK omits the append when the caller opts out', () => {
  const sdkOptions = mapCliOptionsToSDK({ announceRenderCapabilities: false });

  assert.equal(sdkOptions.systemPrompt.type, 'preset');
  assert.equal(sdkOptions.systemPrompt.preset, 'claude_code');
  assert.equal('append' in sdkOptions.systemPrompt, false);
});
