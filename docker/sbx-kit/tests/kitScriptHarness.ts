import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { load as loadYaml } from 'js-yaml';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SPEC_PATH = path.join(__dirname, '..', 'spec.yaml');

type KitSpec = {
  commands: {
    initFiles: Array<{ path: string; content: string }>;
  };
};

let cachedSpec: KitSpec | null = null;

function loadSpec(): KitSpec {
  if (!cachedSpec) {
    cachedSpec = loadYaml(readFileSync(SPEC_PATH, 'utf8')) as KitSpec;
  }
  return cachedSpec;
}

/**
 * Returns the literal shell script content of one `commands.initFiles` entry
 * in spec.yaml, matched by a substring of its `path` (e.g.
 * "mount-host-sessions"). This is the single source of truth — these tests
 * exercise exactly what ships, not a hand-copied approximation of it.
 */
export function loadKitScript(pathFragment: string): string {
  const entry = loadSpec().commands.initFiles.find((file) => file.path.includes(pathFragment));
  if (!entry) {
    throw new Error(`No initFiles entry in spec.yaml matches "${pathFragment}"`);
  }
  return entry.content;
}

export type FakeBinStubs = {
  /** Shell source for a fake `mount` binary. Receives mount's real argv ($1=--bind, $2=src, $3=dst). */
  mount?: string;
  /** Shell source for a fake `mountpoint` binary. Receives mountpoint's real argv ($1=-q, $2=target). */
  mountpoint?: string;
};

export type RunKitScriptResult = {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  /** Root of the fixture filesystem this run operated in — inspect this for assertions, then call cleanup(). */
  root: string;
  mountLog: string[];
  /** Every `chown OWNER:GROUP TARGET` invocation, in order — real chown needs root, which the test harness isn't, so this is how a script's chown *attempts* are verified without actually needing that privilege. */
  chownLog: string[];
  /** Removes the fixture directory tree. Call this once assertions are done. */
  cleanup: () => void;
};

/**
 * Runs a kit script (as `sh`, matching the sandbox's own `#!/bin/sh`
 * shebang) against a disposable fixture directory tree, with `mount` and
 * `mountpoint` replaced by fake executables on PATH so the test can run
 * without root/CAP_SYS_ADMIN and without touching the real filesystem.
 *
 * The fake `mount` logs every `(src, dst)` pair it's called with to a file
 * (`mountLog` in the result) and, by default, symlinks dst -> src so
 * assertions can also just read through the fake mount like a real one
 * would resolve. `mountpoint -q TARGET` succeeds only for a target already
 * in that log, which reproduces a real bind mount's idempotency semantics
 * well enough for these scripts (they only ever check "is this exact path
 * already mounted").
 *
 * `/home/agent` in the script is rewritten to a path inside the fixture
 * root, since the real scripts hardcode it (deliberately — see the
 * $HOME-under-root comments in spec.yaml) and tests can't write there.
 */
export function runKitScript(
  script: string,
  options: {
    setup?: (root: string) => void;
    /**
     * Env vars for the script. A function receives the freshly created
     * fixture root, so tests can point CLOUDCLI_HOST_SESSIONS_DIR etc. at a
     * path under it without a separate "probe" run just to learn the path
     * (and the use-after-cleanup bug that invites).
     */
    env?: Record<string, string> | ((root: string) => Record<string, string>);
    stubs?: FakeBinStubs;
  } = {},
): RunKitScriptResult {
  const root = mkdtempSync(path.join(os.tmpdir(), 'sbx-kit-script-test-'));
  const cleanup = () => rmSync(root, { recursive: true, force: true });

  const fakeHomeAgent = path.join(root, 'home-agent');
  mkdirSync(fakeHomeAgent, { recursive: true });

  options.setup?.(root);
  const resolvedEnv = typeof options.env === 'function' ? options.env(root) : (options.env ?? {});

  const fakeBinDir = path.join(root, 'fakebin');
  mkdirSync(fakeBinDir, { recursive: true });
  const mountLogPath = path.join(root, 'mount.log');
  writeFileSync(mountLogPath, '');

  const mountStub = options.stubs?.mount ?? `
    shift
    src="$1"; dst="$2"
    echo "$dst" >> "${mountLogPath}"
    if [ -d "$src" ]; then
      rmdir "$dst" 2>/dev/null || true
    else
      rm -f "$dst" 2>/dev/null || true
    fi
    ln -sfn "$src" "$dst"
  `;
  const mountpointStub = options.stubs?.mountpoint ?? `
    grep -qxF "$2" "${mountLogPath}" 2>/dev/null
  `;

  writeFileSync(path.join(fakeBinDir, 'mount'), `#!/bin/sh\n${mountStub}\n`, { mode: 0o755 });
  writeFileSync(path.join(fakeBinDir, 'mountpoint'), `#!/bin/sh\n${mountpointStub}\n`, { mode: 0o755 });

  // Real chown needs root, which this harness doesn't run as — faked so a
  // script's chown *attempts* can still be asserted on, same reasoning as
  // mount/mountpoint. Succeeds (so a bare `chown ... || true` in a script
  // under test doesn't need its fallback to make the test pass) and still
  // performs the real chmod-adjacent no-op of nothing, since actually
  // changing ownership isn't needed for any assertion these tests make —
  // only "was it called, with what args" is.
  const chownLogPath = path.join(root, 'chown.log');
  writeFileSync(chownLogPath, '');
  writeFileSync(path.join(fakeBinDir, 'chown'), `#!/bin/sh\necho "$*" >> "${chownLogPath}"\n`, { mode: 0o755 });

  const rewrittenScript = script.split('/home/agent').join(fakeHomeAgent);
  const scriptPath = path.join(root, 'script.sh');
  writeFileSync(scriptPath, rewrittenScript, { mode: 0o755 });

  const result = spawnSync('sh', [scriptPath], {
    cwd: root,
    encoding: 'utf8',
    env: {
      PATH: `${fakeBinDir}:${process.env.PATH ?? ''}`,
      // Some scripts (the ones that run as the agent user) reference
      // $HOME directly; others (the root-run ones, since root's $HOME is
      // /root) hardcode /home/agent instead, rewritten above. Setting
      // both covers either style with no per-script special-casing here.
      HOME: fakeHomeAgent,
      ...resolvedEnv,
    },
  });

  const mountLog = readFileSync(mountLogPath, 'utf8').split('\n').filter(Boolean);
  const chownLog = readFileSync(chownLogPath, 'utf8').split('\n').filter(Boolean);

  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    exitCode: result.status,
    root,
    mountLog,
    chownLog,
    cleanup,
  };
}

export function homeAgentPath(result: Pick<RunKitScriptResult, 'root'>, ...segments: string[]): string {
  return path.join(result.root, 'home-agent', ...segments);
}
