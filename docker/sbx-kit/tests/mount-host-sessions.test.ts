import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { homeAgentPath, loadKitScript, runKitScript } from './kitScriptHarness.js';

/**
 * Exercises `.claude-mount-host-sessions.sh` (the root-run step
 * CCUI_SBX_IMPORT_HOST_SESSIONS/CCUI_SBX_HOST_SESSIONS_MOUNTED_ONLY wire up
 * in spec.yaml) directly from spec.yaml's own content, so these tests fail
 * the moment the shipped script diverges from what's covered here.
 *
 * Covers the full history of bugs found testing this manually across three
 * iterations: mounting a whole project folder shadowing native sandbox
 * sessions of the same name (fixed by per-session-file mounting), nesting
 * under a wrapper directory breaking `claude --resume`'s own cwd-based
 * lookup (fixed by mounting each session at its natural, non-nested path),
 * `set -e` aborting an entire scan on one failed mount, and a naive
 * glob-pattern injection risk in workspace matching.
 */

const SCRIPT = loadKitScript('mount-host-sessions');

function writeJsonl(filePath: string, lines: Array<Record<string, unknown>>): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, lines.map((line) => JSON.stringify(line)).join('\n') + '\n');
}

/** folder-A: two sessions (one at the project root, one from a subdirectory
 * of it) plus subagent artifacts on the first. folder-C: shares a string
 * prefix with project-a but is NOT nested under it. folder-D: no .jsonl at
 * all. folder-E: unrelated project. folder-F: first line has no cwd. */
function buildSessionsFixture(sessionsDir: string): void {
  writeJsonl(path.join(sessionsDir, '-folder-A', 's1.jsonl'), [
    { cwd: '/Users/x/project-a', sessionId: 's1' },
  ]);
  writeJsonl(path.join(sessionsDir, '-folder-A', 's2.jsonl'), [
    { cwd: '/Users/x/project-a/subdir', sessionId: 's2' },
  ]);
  writeJsonl(path.join(sessionsDir, '-folder-A', 's1', 'subagents', 'agent-1.jsonl'), [
    { agent: 'test' },
  ]);
  writeJsonl(path.join(sessionsDir, '-folder-C', 's3.jsonl'), [
    { cwd: '/Users/x/project-aXYZ', sessionId: 's3' },
  ]);
  mkdirSync(path.join(sessionsDir, '-folder-D'), { recursive: true });
  writeJsonl(path.join(sessionsDir, '-folder-E', 's5.jsonl'), [
    { cwd: '/Users/x/totally-unrelated', sessionId: 's5' },
  ]);
  writeJsonl(path.join(sessionsDir, '-folder-F', 's6.jsonl'), [
    { type: 'system', note: 'no cwd here' },
    { cwd: '/Users/x/project-a', sessionId: 's6' },
  ]);
}

const ALL_SESSIONS = [
  ['-folder-A', 's1'],
  ['-folder-A', 's2'],
  ['-folder-C', 's3'],
  ['-folder-E', 's5'],
  ['-folder-F', 's6'],
] as const;

test('CLOUDCLI_HOST_SESSIONS_DIR unset is a clean no-op', () => {
  const result = runKitScript(SCRIPT);
  try {
    assert.equal(result.exitCode, 0);
    assert.deepEqual(result.mountLog, []);
  } finally {
    result.cleanup();
  }
});

test('whole-tree mode: every session file and its artifacts land at the natural, non-nested path', () => {
  const result = runKitScript(SCRIPT, {
    setup: (root) => buildSessionsFixture(path.join(root, 'sessions')),
    env: (root) => ({ CLOUDCLI_HOST_SESSIONS_DIR: path.join(root, 'sessions') }),
  });
  try {
    assert.equal(result.exitCode, 0);

    for (const [folder, session] of ALL_SESSIONS) {
      const target = homeAgentPath(result, '.claude', 'projects', folder, `${session}.jsonl`);
      assert.ok(existsSync(target), `${folder}/${session}.jsonl should be mounted at its natural path`);
    }
    assert.ok(
      !existsSync(homeAgentPath(result, '.claude', 'projects', '.imported-host-sessions')),
      'no wrapper directory should exist anywhere',
    );
    assert.ok(!existsSync(homeAgentPath(result, '.claude', 'projects', '-folder-D')), 'a folder with no .jsonl mounts nothing');
    assert.ok(
      existsSync(homeAgentPath(result, '.claude', 'projects', '-folder-A', 's1', 'subagents', 'agent-1.jsonl')),
      'subagent artifacts must be mounted alongside their session',
    );
  } finally {
    result.cleanup();
  }
});

test('mounted-only: matches a session at the exact workspace path', () => {
  const result = runKitScript(SCRIPT, {
    setup: (root) => buildSessionsFixture(path.join(root, 'sessions')),
    env: (root) => ({
      CLOUDCLI_HOST_SESSIONS_DIR: path.join(root, 'sessions'),
      CLOUDCLI_HOST_SESSIONS_MOUNTED_ONLY: '1',
      CLOUDCLI_MOUNTED_WORKSPACE_PATHS: '/Users/x/project-a',
    }),
  });
  try {
    assert.ok(existsSync(homeAgentPath(result, '.claude', 'projects', '-folder-A', 's1.jsonl')));
  } finally {
    result.cleanup();
  }
});

test('mounted-only: matches a session whose cwd is a subdirectory of the workspace', () => {
  const result = runKitScript(SCRIPT, {
    setup: (root) => buildSessionsFixture(path.join(root, 'sessions')),
    env: (root) => ({
      CLOUDCLI_HOST_SESSIONS_DIR: path.join(root, 'sessions'),
      CLOUDCLI_HOST_SESSIONS_MOUNTED_ONLY: '1',
      CLOUDCLI_MOUNTED_WORKSPACE_PATHS: '/Users/x/project-a',
    }),
  });
  try {
    assert.ok(
      existsSync(homeAgentPath(result, '.claude', 'projects', '-folder-A', 's2.jsonl')),
      'a session run from project-a/subdir must match workspace project-a',
    );
  } finally {
    result.cleanup();
  }
});

test('mounted-only: a string prefix that is not actually nested under the workspace does not match', () => {
  const result = runKitScript(SCRIPT, {
    setup: (root) => buildSessionsFixture(path.join(root, 'sessions')),
    env: (root) => ({
      CLOUDCLI_HOST_SESSIONS_DIR: path.join(root, 'sessions'),
      CLOUDCLI_HOST_SESSIONS_MOUNTED_ONLY: '1',
      CLOUDCLI_MOUNTED_WORKSPACE_PATHS: '/Users/x/project-a',
    }),
  });
  try {
    assert.ok(
      !existsSync(homeAgentPath(result, '.claude', 'projects', '-folder-C', 's3.jsonl')),
      'project-aXYZ must not match a project-a workspace',
    );
  } finally {
    result.cleanup();
  }
});

test('mounted-only: an unrelated project does not match', () => {
  const result = runKitScript(SCRIPT, {
    setup: (root) => buildSessionsFixture(path.join(root, 'sessions')),
    env: (root) => ({
      CLOUDCLI_HOST_SESSIONS_DIR: path.join(root, 'sessions'),
      CLOUDCLI_HOST_SESSIONS_MOUNTED_ONLY: '1',
      CLOUDCLI_MOUNTED_WORKSPACE_PATHS: '/Users/x/project-a',
    }),
  });
  try {
    assert.ok(!existsSync(homeAgentPath(result, '.claude', 'projects', '-folder-E', 's5.jsonl')));
  } finally {
    result.cleanup();
  }
});

test('mounted-only: a folder with no .jsonl files is skipped cleanly, no error', () => {
  const result = runKitScript(SCRIPT, {
    setup: (root) => buildSessionsFixture(path.join(root, 'sessions')),
    env: (root) => ({
      CLOUDCLI_HOST_SESSIONS_DIR: path.join(root, 'sessions'),
      CLOUDCLI_HOST_SESSIONS_MOUNTED_ONLY: '1',
      CLOUDCLI_MOUNTED_WORKSPACE_PATHS: '/',
    }),
  });
  try {
    assert.equal(result.exitCode, 0);
    assert.ok(!existsSync(homeAgentPath(result, '.claude', 'projects', '-folder-D')));
  } finally {
    result.cleanup();
  }
});

test('mounted-only: the cwd scan keeps reading lines past a non-cwd-bearing first record', () => {
  const result = runKitScript(SCRIPT, {
    setup: (root) => buildSessionsFixture(path.join(root, 'sessions')),
    env: (root) => ({
      CLOUDCLI_HOST_SESSIONS_DIR: path.join(root, 'sessions'),
      CLOUDCLI_HOST_SESSIONS_MOUNTED_ONLY: '1',
      CLOUDCLI_MOUNTED_WORKSPACE_PATHS: '/Users/x/project-a',
    }),
  });
  try {
    assert.ok(existsSync(homeAgentPath(result, '.claude', 'projects', '-folder-F', 's6.jsonl')));
  } finally {
    result.cleanup();
  }
});

test('mounted-only: a workspace of "/" matches every session that has a cwd', () => {
  const result = runKitScript(SCRIPT, {
    setup: (root) => buildSessionsFixture(path.join(root, 'sessions')),
    env: (root) => ({
      CLOUDCLI_HOST_SESSIONS_DIR: path.join(root, 'sessions'),
      CLOUDCLI_HOST_SESSIONS_MOUNTED_ONLY: '1',
      CLOUDCLI_MOUNTED_WORKSPACE_PATHS: '/',
    }),
  });
  try {
    for (const [folder, session] of ALL_SESSIONS) {
      assert.ok(existsSync(homeAgentPath(result, '.claude', 'projects', folder, `${session}.jsonl`)));
    }
  } finally {
    result.cleanup();
  }
});

test('mounted-only: multiple colon-joined workspaces are all honored', () => {
  const result = runKitScript(SCRIPT, {
    setup: (root) => buildSessionsFixture(path.join(root, 'sessions')),
    env: (root) => ({
      CLOUDCLI_HOST_SESSIONS_DIR: path.join(root, 'sessions'),
      CLOUDCLI_HOST_SESSIONS_MOUNTED_ONLY: '1',
      CLOUDCLI_MOUNTED_WORKSPACE_PATHS: '/Users/x/totally-unrelated:/Users/x/project-a',
    }),
  });
  try {
    assert.ok(existsSync(homeAgentPath(result, '.claude', 'projects', '-folder-A', 's1.jsonl')));
    assert.ok(existsSync(homeAgentPath(result, '.claude', 'projects', '-folder-E', 's5.jsonl')));
    assert.ok(!existsSync(homeAgentPath(result, '.claude', 'projects', '-folder-C', 's3.jsonl')));
  } finally {
    result.cleanup();
  }
});

test('mounted-only: a workspace path containing glob-special characters is matched literally, not as a pattern', () => {
  const result = runKitScript(SCRIPT, {
    setup: (root) => {
      buildSessionsFixture(path.join(root, 'sessions'));
      writeJsonl(path.join(root, 'sessions', '-folder-glob', 's7.jsonl'), [
        { cwd: '/Users/x/not-the-glob-project', sessionId: 's7' },
      ]);
    },
    env: (root) => ({
      CLOUDCLI_HOST_SESSIONS_DIR: path.join(root, 'sessions'),
      CLOUDCLI_HOST_SESSIONS_MOUNTED_ONLY: '1',
      // A glob-vulnerable matcher would treat this as a pattern and wrongly
      // match /Users/x/project-a (folder-A's sessions) against it.
      CLOUDCLI_MOUNTED_WORKSPACE_PATHS: '/Users/x/project-[a-z]*',
    }),
  });
  try {
    assert.ok(!existsSync(homeAgentPath(result, '.claude', 'projects', '-folder-glob', 's7.jsonl')));
    assert.ok(!existsSync(homeAgentPath(result, '.claude', 'projects', '-folder-A', 's1.jsonl')));
  } finally {
    result.cleanup();
  }
});

test('re-running against the same fixture is idempotent (no duplicate mount attempts)', () => {
  const result = runKitScript(SCRIPT, {
    setup: (root) => buildSessionsFixture(path.join(root, 'sessions')),
    env: (root) => ({ CLOUDCLI_HOST_SESSIONS_DIR: path.join(root, 'sessions') }),
  });
  try {
    const firstRunMountLog = [...result.mountLog].sort();
    assert.ok(firstRunMountLog.length > 0);

    // Re-invoke the exact same script in the exact same fixture, the way a
    // sandbox restart would — mountpoint -q against the first run's own
    // targets must report true, so the second pass appends nothing new.
    const second = spawnSync('sh', [path.join(result.root, 'script.sh')], {
      cwd: result.root,
      encoding: 'utf8',
      env: {
        PATH: `${path.join(result.root, 'fakebin')}:${process.env.PATH ?? ''}`,
        CLOUDCLI_HOST_SESSIONS_DIR: path.join(result.root, 'sessions'),
      },
    });
    assert.equal(second.status, 0);

    const secondRunMountLog = readFileSync(path.join(result.root, 'mount.log'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .sort();
    assert.deepEqual(secondRunMountLog, firstRunMountLog, 'no new mount attempts on a re-run against the same fixture');
  } finally {
    result.cleanup();
  }
});

test('a mount failure for one session does not abort the rest of the scan', () => {
  const result = runKitScript(SCRIPT, {
    setup: (root) => buildSessionsFixture(path.join(root, 'sessions')),
    env: (root) => ({ CLOUDCLI_HOST_SESSIONS_DIR: path.join(root, 'sessions') }),
    stubs: {
      mount: `
        shift
        src="$1"; dst="$2"
        case "$src" in
          *s1.jsonl) exit 1 ;;
        esac
        if [ -d "$src" ]; then rmdir "$dst" 2>/dev/null || true; else rm -f "$dst" 2>/dev/null || true; fi
        ln -sfn "$src" "$dst"
      `,
    },
  });
  try {
    assert.equal(result.exitCode, 0, 'the script itself must not abort');

    // bind_mount_once touches an empty placeholder before attempting the
    // mount, so the failed target exists but is empty — it was never
    // populated with the real session content.
    const failedTarget = homeAgentPath(result, '.claude', 'projects', '-folder-A', 's1.jsonl');
    assert.ok(existsSync(failedTarget));
    assert.equal(readFileSync(failedTarget, 'utf8'), '', 'the failed mount leaves only the empty placeholder, never the real content');

    assert.ok(existsSync(homeAgentPath(result, '.claude', 'projects', '-folder-A', 's2.jsonl')), 'later sessions in the same folder still get mounted');
    const s2Content = readFileSync(homeAgentPath(result, '.claude', 'projects', '-folder-A', 's2.jsonl'), 'utf8');
    assert.ok(s2Content.includes('"sessionId":"s2"'), 's2 is a real mount, not just a placeholder');
    assert.ok(existsSync(homeAgentPath(result, '.claude', 'projects', '-folder-E', 's5.jsonl')), 'later folders still get processed');
  } finally {
    result.cleanup();
  }
});

test('every project folder is chowned to the agent uid, not left root-owned', () => {
  // Regression test: this step runs as root (bind mounts need
  // CAP_SYS_ADMIN), so `mkdir -p "$natural_folder"` creates that folder as
  // root. Unlike the files mounted inside it, the folder itself is never
  // overlaid by a mount, so it stays root-owned forever unless chowned —
  // which silently blocked the agent's own native `claude` CLI from ever
  // writing a *new* file into a project folder that had an imported
  // session mounted into it. Reproduced directly in a real container
  // before this fix; this only verifies the script *attempts* the chown
  // (real chown needs root, which this harness isn't), since the
  // ownership-enforcement itself is kernel behavior, not shell logic.
  const result = runKitScript(SCRIPT, {
    setup: (root) => buildSessionsFixture(path.join(root, 'sessions')),
    env: (root) => ({ CLOUDCLI_HOST_SESSIONS_DIR: path.join(root, 'sessions') }),
  });
  try {
    const expectedFolders = ['-folder-A', '-folder-C', '-folder-E', '-folder-F'];
    for (const folder of expectedFolders) {
      const natural = homeAgentPath(result, '.claude', 'projects', folder);
      assert.ok(
        result.chownLog.some((line) => line === `1000:1000 ${natural}`),
        `expected a chown of ${natural}, got: ${result.chownLog.join(' | ')}`,
      );
    }
  } finally {
    result.cleanup();
  }
});
