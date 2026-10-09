import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CCUI_SBX_PATH = path.join(__dirname, '..', 'bin', 'ccui-sbx');

/**
 * Exercises `ccui-sbx` end to end as a subprocess, against a stubbed `sbx`
 * binary that just records the argv it was invoked with — this is exactly
 * the technique used to manually verify every feature added to this script
 * this session, now kept as regression coverage instead of being thrown
 * away after each manual check.
 *
 * Uses CCUI_SBX_ATTACH=1 throughout so the script takes its `exec sbx run
 * claude ...` path immediately, rather than the headless path's port
 * -publish/admin-password-poll logic (which calls `sbx ports`/`sbx exec`
 * repeatedly — out of scope here, already covered by this session's live
 * sandbox verification, not practical to fake over child_process).
 */

type Harness = {
  root: string;
  fakeBinDir: string;
  home: string;
  cleanup: () => void;
};

function makeHarness(): Harness {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ccui-sbx-test-'));
  const fakeBinDir = path.join(root, 'fakebin');
  mkdirSync(fakeBinDir, { recursive: true });
  writeFileSync(
    path.join(fakeBinDir, 'sbx'),
    '#!/bin/bash\necho "ARGV_START"\nfor a in "$@"; do echo "ARG:$a"; done\necho "ARGV_END"\n',
    { mode: 0o755 },
  );
  const home = path.join(root, 'home');
  mkdirSync(home, { recursive: true });
  return { root, fakeBinDir, home, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function runCcuiSbx(
  harness: Harness,
  args: string[],
  env: Record<string, string> = {},
): { argv: string[]; stderr: string; exitCode: number | null } {
  const result = spawnSync('bash', [CCUI_SBX_PATH, ...args], {
    encoding: 'utf8',
    env: {
      PATH: `${harness.fakeBinDir}:${process.env.PATH ?? ''}`,
      HOME: harness.home,
      CCUI_SBX_ATTACH: '1',
      ...env,
    },
  });

  const lines = (result.stdout ?? '').split('\n');
  const start = lines.indexOf('ARGV_START');
  const end = lines.indexOf('ARGV_END');
  const argv = start >= 0 && end > start
    ? lines.slice(start + 1, end).map((line) => line.replace(/^ARG:/, ''))
    : [];

  return { argv, stderr: result.stderr ?? '', exitCode: result.status };
}

function makeWorkspace(harness: Harness, name: string): string {
  const dir = path.join(harness.root, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

test('with no CCUI_SBX_* vars set, no extra env flags are added', () => {
  const harness = makeHarness();
  try {
    const primary = makeWorkspace(harness, 'primary');
    const { argv, exitCode } = runCcuiSbx(harness, [primary]);
    assert.equal(exitCode, 0);
    assert.ok(!argv.some((a) => a.includes('CLOUDCLI_')), `no CLOUDCLI_ env flags expected, got: ${argv.join(' ')}`);
  } finally {
    harness.cleanup();
  }
});

test('CCUI_SBX_HOST_SESSIONS_MOUNTED_ONLY resolves CLOUDCLI_MOUNTED_WORKSPACE_PATHS from the primary and extra workspace', () => {
  const harness = makeHarness();
  try {
    const primary = makeWorkspace(harness, 'primary');
    const extra = makeWorkspace(harness, 'extra');
    const sessionsDir = makeWorkspace(harness, 'sessions');
    const { argv } = runCcuiSbx(harness, [primary, extra], {
      CCUI_SBX_IMPORT_HOST_SESSIONS: '1',
      CCUI_SBX_HOST_SESSIONS_MOUNTED_ONLY: '1',
      CCUI_SBX_HOST_SESSIONS_DIR: sessionsDir,
    });

    const workspacePathsArg = argv.find((a) => a.startsWith('CLOUDCLI_MOUNTED_WORKSPACE_PATHS='));
    assert.ok(workspacePathsArg, `expected CLOUDCLI_MOUNTED_WORKSPACE_PATHS, got: ${argv.join(' | ')}`);
    const paths = workspacePathsArg!.slice('CLOUDCLI_MOUNTED_WORKSPACE_PATHS='.length).split(':');

    // Resolved via `pwd -P` (physical path), not the logical path Node's
    // own mkdtemp/os.tmpdir() return — on macOS that's exactly the
    // difference between /var/... and /private/var/..., the same class of
    // symlink this resolution was added to handle (realpathSync here is
    // the Node equivalent of the script's own `pwd -P`).
    assert.ok(paths.includes(realpathSync(primary)), `expected the physically-resolved primary path among: ${paths.join(', ')}`);
    assert.ok(paths.includes(realpathSync(extra)), `expected the physically-resolved extra path among: ${paths.join(', ')}`);

    assert.ok(argv.includes('CLOUDCLI_HOST_SESSIONS_MOUNTED_ONLY=1'));
  } finally {
    harness.cleanup();
  }
});

test('CLOUDCLI_MOUNTED_WORKSPACE_PATHS is physically resolved, not just logically — the symlink case the fix was for', () => {
  // Reproduces the real bug directly: a workspace path with a symlinked
  // ancestor must still match a session's own (always physically resolved)
  // recorded cwd. `os.tmpdir()` on macOS already has exactly this property
  // (/var -> /private/var), which is what the test above's realpathSync
  // comparison is quietly relying on — this test makes that mechanism
  // explicit with a symlink of our own, so it's not accidental coverage.
  const harness = makeHarness();
  try {
    const realWorkspace = makeWorkspace(harness, 'real-workspace');
    const symlinkedWorkspace = path.join(harness.root, 'symlinked-workspace');
    symlinkSync(realWorkspace, symlinkedWorkspace);

    const sessionsDir = makeWorkspace(harness, 'sessions');
    const { argv } = runCcuiSbx(harness, [symlinkedWorkspace], {
      CCUI_SBX_IMPORT_HOST_SESSIONS: '1',
      CCUI_SBX_HOST_SESSIONS_MOUNTED_ONLY: '1',
      CCUI_SBX_HOST_SESSIONS_DIR: sessionsDir,
    });

    const workspacePathsArg = argv.find((a) => a.startsWith('CLOUDCLI_MOUNTED_WORKSPACE_PATHS='));
    assert.ok(workspacePathsArg);
    const paths = workspacePathsArg!.slice('CLOUDCLI_MOUNTED_WORKSPACE_PATHS='.length).split(':');
    assert.ok(
      paths.includes(realpathSync(realWorkspace)),
      `a symlinked workspace must resolve to its real target, got: ${paths.join(', ')}`,
    );
    assert.ok(!paths.includes(symlinkedWorkspace), 'the unresolved symlink path itself must not appear');
  } finally {
    harness.cleanup();
  }
});

test('CCUI_SBX_SKILLS_PLUGINS mounts each plugin dir read-only and sets CLOUDCLI_EXTRA_SKILLS_DIRS', () => {
  const harness = makeHarness();
  try {
    const primary = makeWorkspace(harness, 'primary');
    const pluginA = makeWorkspace(harness, 'plugin-a');
    const pluginB = makeWorkspace(harness, 'plugin-b');
    const { argv } = runCcuiSbx(harness, [primary], {
      CCUI_SBX_SKILLS_PLUGINS: `${pluginA}:${pluginB}`,
    });

    assert.ok(argv.includes(`${pluginA}:ro`));
    assert.ok(argv.includes(`${pluginB}:ro`));
    const skillsDirsArg = argv.find((a) => a.startsWith('CLOUDCLI_EXTRA_SKILLS_DIRS='));
    assert.equal(skillsDirsArg, `CLOUDCLI_EXTRA_SKILLS_DIRS=${pluginA}:${pluginB}`);
  } finally {
    harness.cleanup();
  }
});

test('CCUI_SBX_HOST_SESSIONS_READONLY appends :ro to the sessions mount', () => {
  const harness = makeHarness();
  try {
    const primary = makeWorkspace(harness, 'primary');
    const sessionsDir = makeWorkspace(harness, 'sessions');
    const { argv } = runCcuiSbx(harness, [primary], {
      CCUI_SBX_IMPORT_HOST_SESSIONS: '1',
      CCUI_SBX_HOST_SESSIONS_DIR: sessionsDir,
      CCUI_SBX_HOST_SESSIONS_READONLY: '1',
    });
    assert.ok(argv.includes(`${sessionsDir}:ro`), `expected read-only mount, got: ${argv.join(' | ')}`);
  } finally {
    harness.cleanup();
  }
});

test('sessions mount is read-write by default (no :ro)', () => {
  const harness = makeHarness();
  try {
    const primary = makeWorkspace(harness, 'primary');
    const sessionsDir = makeWorkspace(harness, 'sessions');
    const { argv } = runCcuiSbx(harness, [primary], {
      CCUI_SBX_IMPORT_HOST_SESSIONS: '1',
      CCUI_SBX_HOST_SESSIONS_DIR: sessionsDir,
    });
    assert.ok(argv.includes(sessionsDir), `expected a plain read-write mount, got: ${argv.join(' | ')}`);
    assert.ok(!argv.includes(`${sessionsDir}:ro`));
  } finally {
    harness.cleanup();
  }
});

test('extra mounts are spliced before a trailing -- separator, never after', () => {
  const harness = makeHarness();
  try {
    const primary = makeWorkspace(harness, 'primary');
    const pluginA = makeWorkspace(harness, 'plugin-a');
    const { argv } = runCcuiSbx(harness, [primary, '--', '--continue'], {
      CCUI_SBX_SKILLS_PLUGINS: pluginA,
    });

    const dashDashIndex = argv.indexOf('--');
    const mountIndex = argv.indexOf(`${pluginA}:ro`);
    assert.ok(dashDashIndex >= 0, '-- must be forwarded');
    assert.ok(mountIndex >= 0 && mountIndex < dashDashIndex, 'the plugin mount must come before --');
    assert.deepEqual(argv.slice(dashDashIndex), ['--', '--continue']);
  } finally {
    harness.cleanup();
  }
});

test('the primary workspace keeps its first positional slot ahead of any extra mounts', () => {
  const harness = makeHarness();
  try {
    const primary = makeWorkspace(harness, 'primary');
    const pluginA = makeWorkspace(harness, 'plugin-a');
    const { argv } = runCcuiSbx(harness, [primary], { CCUI_SBX_SKILLS_PLUGINS: pluginA });

    const primaryIndex = argv.indexOf(primary);
    const mountIndex = argv.indexOf(`${pluginA}:ro`);
    assert.ok(primaryIndex >= 0 && mountIndex >= 0);
    assert.ok(primaryIndex < mountIndex, 'the primary workspace must not be displaced by an added mount');
  } finally {
    harness.cleanup();
  }
});

test('~/.ccui-sbx.yml fills in an unset var, a real env var still wins over the file', () => {
  const harness = makeHarness();
  try {
    const primary = makeWorkspace(harness, 'primary');
    const pluginA = makeWorkspace(harness, 'plugin-a');
    writeFileSync(path.join(harness.home, '.ccui-sbx.yml'), `CCUI_SBX_SKILLS_PLUGINS: "${pluginA}"\n`);

    const fromFile = runCcuiSbx(harness, [primary]);
    assert.ok(fromFile.argv.includes(`${pluginA}:ro`), 'the config file value should be picked up when the env var is unset');

    const pluginOverride = makeWorkspace(harness, 'plugin-override');
    const withOverride = runCcuiSbx(harness, [primary], { CCUI_SBX_SKILLS_PLUGINS: pluginOverride });
    assert.ok(withOverride.argv.includes(`${pluginOverride}:ro`));
    assert.ok(!withOverride.argv.includes(`${pluginA}:ro`), 'a real env var must win over the config file, not merge with it');
  } finally {
    harness.cleanup();
  }
});

test('~/.ccui-sbx.yml tilde-expands a value against $HOME', () => {
  const harness = makeHarness();
  try {
    const primary = makeWorkspace(harness, 'primary');
    mkdirSync(path.join(harness.home, 'nested-plugin'), { recursive: true });
    writeFileSync(path.join(harness.home, '.ccui-sbx.yml'), 'CCUI_SBX_SKILLS_PLUGINS: "~/nested-plugin"\n');

    const { argv } = runCcuiSbx(harness, [primary]);
    assert.ok(argv.includes(`${path.join(harness.home, 'nested-plugin')}:ro`));
  } finally {
    harness.cleanup();
  }
});

test('a missing ~/.ccui-sbx.yml is a clean no-op', () => {
  const harness = makeHarness();
  try {
    const primary = makeWorkspace(harness, 'primary');
    const { exitCode, argv } = runCcuiSbx(harness, [primary]);
    assert.equal(exitCode, 0);
    assert.ok(!argv.some((a) => a.includes('CLOUDCLI_')));
  } finally {
    harness.cleanup();
  }
});

test('~/.ccui-sbx.yml ignores non-CCUI_SBX_ keys and comments', () => {
  const harness = makeHarness();
  try {
    const primary = makeWorkspace(harness, 'primary');
    writeFileSync(
      path.join(harness.home, '.ccui-sbx.yml'),
      [
        '# a full-line comment',
        'NOT_OUR_VAR: should-be-ignored',
        'CCUI_SBX_HOST_SESSIONS_READONLY: "1"   # trailing comment',
      ].join('\n'),
    );
    const sessionsDir = makeWorkspace(harness, 'sessions');
    const { argv } = runCcuiSbx(harness, [primary], {
      CCUI_SBX_IMPORT_HOST_SESSIONS: '1',
      CCUI_SBX_HOST_SESSIONS_DIR: sessionsDir,
    });
    assert.ok(argv.includes(`${sessionsDir}:ro`), 'CCUI_SBX_HOST_SESSIONS_READONLY from the file, trailing comment stripped, should apply');
  } finally {
    harness.cleanup();
  }
});
