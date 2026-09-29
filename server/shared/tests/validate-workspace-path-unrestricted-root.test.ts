import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

// WORKSPACES_ROOT is read once at module load, so this file sets it to a
// bare filesystem root BEFORE importing — the exact scenario the sbx kit
// relies on (WORKSPACES_ROOT="/") to accept a workspace mounted at its
// verbatim host path outside os.homedir(). A separate process/test file
// (any other test that imports server/shared/utils.js without this env
// var set) still exercises the default os.homedir()-restricted behavior
// unaffected by this change.
process.env.WORKSPACES_ROOT = '/';
const { validateWorkspacePath } = await import('../utils.js');

test('an unrestricted root ("/") accepts a path outside the historical default root', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-root-test-'));
  try {
    const result = await validateWorkspacePath(tempDir);
    assert.equal(result.valid, true);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('an unrestricted root still blocks FORBIDDEN_WORKSPACE_PATHS entries', async () => {
  const result = await validateWorkspacePath('/etc');
  assert.equal(result.valid, false);
});

test('an unrestricted root still rejects the bare root itself', async () => {
  const result = await validateWorkspacePath('/');
  assert.equal(result.valid, false);
});
