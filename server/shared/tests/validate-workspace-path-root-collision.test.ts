import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

// WORKSPACES_ROOT is read once at module load. This file exercises the case
// where the *configured root itself* happens to coincide with a
// FORBIDDEN_WORKSPACE_PATHS entry — exactly what happens in any
// container/sandbox running as root, where os.homedir() (the default
// WORKSPACES_ROOT) is /root, itself on the forbidden list. Using /tmp here
// instead of the literal /root string, since /tmp reliably exists and is
// accessible everywhere a test runs, while /root may not exist at all on a
// non-Linux dev machine — the collision being tested is "root equals a
// forbidden-list entry", not anything specific to /root itself.
process.env.WORKSPACES_ROOT = '/tmp';
const { validateWorkspacePath } = await import('../utils.js');

test('the configured root is valid even when it collides with a forbidden-path entry', async () => {
  const result = await validateWorkspacePath('/tmp');
  assert.equal(result.valid, true);
});

test('a different forbidden path is still rejected despite the root collision', async () => {
  const result = await validateWorkspacePath('/etc');
  assert.equal(result.valid, false);
});

test('a real subdirectory under the colliding root still validates normally', async () => {
  // Built directly under literal /tmp rather than via os.tmpdir(), which on
  // macOS resolves to /var/folders/... — a different path not contained
  // under a WORKSPACES_ROOT of /tmp, which would defeat the point of this
  // containment check.
  const tempDir = await fs.mkdtemp(path.join('/tmp', 'root-collision-test-'));
  try {
    const result = await validateWorkspacePath(tempDir);
    assert.equal(result.valid, true);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
