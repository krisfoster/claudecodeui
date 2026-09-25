import { existsSync } from 'node:fs';

import { test } from 'vitest';
import assert from 'node:assert/strict';

import { d3BundlePlugin } from './d3BundlePlugin.js';

// `d3Sandbox.test.tsx` mocks `d3-bundle-source?raw` directly, which never
// exercises this plugin's actual `resolveId`. This drives the real thing
// against the actually-installed `d3` package so a future release
// reorganizing its layout fails a test instead of only breaking silently
// at runtime.
test('resolveId resolves the virtual id to a real file on disk', () => {
  const plugin = d3BundlePlugin();

  const resolved = plugin.resolveId('d3-bundle-source');
  assert.ok(resolved, 'expected a resolved path');
  assert.ok(existsSync(resolved), `expected ${resolved} to exist`);

  const resolvedWithQuery = plugin.resolveId('d3-bundle-source?raw');
  assert.equal(resolvedWithQuery, `${resolved}?raw`);

  assert.equal(plugin.resolveId('something-else'), null);
});
