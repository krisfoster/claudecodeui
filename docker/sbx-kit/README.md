# claudecodeui-dev sbx kit

A [Docker Sandboxes](https://docs.docker.com/ai/sandboxes/) `kind: mixin` kit
that runs **this checkout's source** (not the published `@cloudcli-ai/cloudcli`
package) inside a sandbox. Use it to develop/test claudecodeui itself in a
clean, disposable Linux environment instead of on the host.

It installs `build-essential`/`python3` (needed to compile the native
modules: `better-sqlite3`, `node-pty`, `bcrypt`), then on every container
start runs `npm install`, rebuilds those native modules for the sandbox's
platform, and launches `npm run dev` in the background.

## Why the rebuild step

The workspace is bind-mounted, not copied, so a `node_modules` already built
on the host (macOS/other arch) is visible inside the Linux sandbox too.
Native `.node` binaries are not portable across platforms, so the kit forces
a rebuild inside the sandbox on every start. The reverse is also true: after
using this kit, native modules in `node_modules` will be Linux binaries and
won't load if you go back to running `npm run dev` directly on the host
until you `npm rebuild` there again.

## Permissions default

The kit sets `CLOUDCLI_DEFAULT_CLAUDE_SKIP_PERMISSIONS=true` in the
container's environment. `server/modules/auth/auth.module.ts` reads that at
startup and, only at the moment the sandbox's one user account is first
registered through the web UI, seeds their `claudePermissions` preference
with `skipPermissions: true` — matching the sandbox's own interactive
`claude` agent, which already runs with `--dangerously-skip-permissions`.
Without this, every tool call in a web-UI chat session prompts for approval,
since the app's default permission mode is independent of that CLI flag.

This only affects the one-time account creation; it never touches an
existing account's settings. To go back to the historical ask-every-time
default, remove the `CLOUDCLI_DEFAULT_CLAUDE_SKIP_PERMISSIONS` line from
`spec.yaml`'s `environment.variables`.

## Auto-created admin account

The kit also sets `CLOUDCLI_AUTO_CREATE_ADMIN=true`. At boot, if no user
exists yet, the server creates one (username `admin`) with a randomly
generated password and prints it to stdout once. `ccui-sbx` reads it back
out of the sandbox and shows it in its startup summary — no need to open
the web UI and fill in the setup form before you can sign in. Like the
permissions default above, this never touches an existing account; a
sandbox that already had a user before this run simply won't print (or
find) a password.

This is meant for disposable, single-user dev sandboxes: the password is
printed once to a log a container operator can read, which trades a bit of
that for "nobody has to be watching a browser at the right moment." It is
not a production security posture — don't set `CLOUDCLI_AUTO_CREATE_ADMIN`
outside a throwaway sandbox. To turn it off, remove the
`CLOUDCLI_AUTO_CREATE_ADMIN` line from `spec.yaml`'s `environment.variables`
and go back to registering manually through the web UI. `CLOUDCLI_ADMIN_USERNAME`
and `CLOUDCLI_ADMIN_PASSWORD` (set directly on the server process, not
currently exposed via this kit) override the generated username/password
if you need a fixed value instead.

## Extra mounted workspaces become the default project

`sbx` always bind-mounts a workspace at its exact host absolute path
(e.g. `/Users/<you>/claude_work/kb`) — never remapped under `/home/agent`,
for the primary workspace or any extra one, and there's no `sbx` flag to
change that. The app's own default `WORKSPACES_ROOT` (`os.homedir()`,
i.e. `/home/agent` in the sandbox) would reject every one of those paths
if you tried adding it as a project by hand. The kit sets
`WORKSPACES_ROOT=/` to fix that — `FORBIDDEN_WORKSPACE_PATHS`
(`server/shared/utils.ts`) still blocks `/etc`, `/bin`, `/usr`, `/var`,
`/root`, bare `/`, etc. regardless of this value, so this doesn't disable
the safety floor; it just stops the extra home-directory-shaped
restriction from rejecting paths that are only "wrong" because they
don't live under `/home/agent`. The sandbox's own mount boundary (nothing
exists in here except what you explicitly mounted) is the real security
boundary for a disposable single-user dev sandbox — this is not a
production posture, and shouldn't be set outside one.

Pass a second workspace path to `ccui-sbx` and it's mounted **and**
auto-registered as a project — no manual folder-browser/path-typing, and
no "outside the allowed workspace root" error:

```bash
ccui-sbx . ~/claude_work/kb
```

`ccui-sbx` resolves that second path to its absolute form and sets
`CLOUDCLI_DEFAULT_PROJECT_PATH` on the sandbox; the server registers it
at boot (idempotently — a restart with the same path is a silent no-op,
not a duplicate or an error) and it shows up ready to open once the UI
loads. `CLOUDCLI_ADMIN_USERNAME`/`CLOUDCLI_ADMIN_PASSWORD` are the
matching direct-env-var overrides described above; there's no separate
override for the project path today beyond passing a different second
argument.

## Usage

### Option A: `ccui-sbx` launcher (recommended)

[`bin/ccui-sbx`](bin/ccui-sbx) is a thin wrapper around `sbx run claude` that
attaches this kit and publishes both ports automatically. Every other
argument is forwarded to `sbx run` untouched, so it takes all the normal
`sbx run` flags (`--name`, `--env`, `--clone`, `-- AGENT_ARGS`, etc).

It creates the sandbox **headless** (`--detached`) by default: the claude
TUI never takes over your terminal, so the actual published ports (which
can differ from 3001/5173 if those are already busy — see below) stay
visible in a summary printed once the sandbox is up. On a fresh sandbox it
waits (up to ~60s) for first-time setup — `npm install` plus the native
module rebuild — to finish and print the generated admin password before
showing that summary:

```
── ccui-sbx: 'ccui-claudecodeui-3514440038' is running headless ──
  Web UI / API:  http://127.0.0.1:49158
  Vite (HMR):    http://127.0.0.1:49159

  Admin login:   admin / 3f1a9c2e8b7d4f0a1e6c5b3a9d8f7e2c

  Attach to the claude agent:   sbx run --name ccui-claudecodeui-3514440038
  Tail the dev server logs:    sbx exec ccui-claudecodeui-3514440038 bash -lc 'tail -f /tmp/claudecodeui-dev.log'
  Stop it:                     sbx stop ccui-claudecodeui-3514440038
```

Set `CCUI_SBX_ATTACH=1` to get the old behavior instead: attach to the
interactive claude session immediately after creation.

Install it once, from the repo root:

```bash
mkdir -p ~/.local/bin
ln -sf "$(pwd)/docker/sbx-kit/bin/ccui-sbx" ~/.local/bin/ccui-sbx
```

Make sure `~/.local/bin` is on your `PATH`, then run it from anywhere:

```bash
ccui-sbx                          # mount $PWD as the workspace
ccui-sbx ~/repos/claudecodeui     # mount a specific checkout
ccui-sbx . --name ccui-dev        # any normal sbx run flag works
```

The kit is resolved from the symlink's real target, so it always uses the
kit shipped in the checkout you installed from — regardless of which
directory you're in or which checkout you point it at.

Override the published host ports (container ports stay 3001/5173) or skip
the kit entirely with env vars:

```bash
CCUI_SBX_SERVER_PORT=13001 CCUI_SBX_CLIENT_PORT=15173 ccui-sbx .   # force specific host ports
CCUI_SBX_NO_KIT=1 ccui-sbx .                                       # plain claude sandbox, ports only
CCUI_SBX_ATTACH=1 ccui-sbx .                                       # attach to claude interactively
CCUI_SBX_NO_OPEN=1 ccui-sbx .                                      # don't auto-open the browser
```

Once headless mode is up, `ccui-sbx` also auto-opens the Vite client URL in
your default browser (`open` on macOS, `xdg-open`/`wslview` on Linux/WSL —
silently skipped if none of those exist). If a fresh admin account was just
auto-created, the opened URL includes `?username=&password=`, which the
login form reads once to prefill both fields and then immediately scrubs
from the address bar/history — so the page comes up ready to just hit
"Sign in." The password is also copied to your clipboard as a fallback.

If a default or forced host port is already taken, `ccui-sbx` doesn't fail
the launch — it lets `sbx` allocate an ephemeral port instead and reports
whatever port actually got used in the summary above.

#### Setting defaults in `~/.ccui-sbx.yml`

Any `CCUI_SBX_*` env var can be given a default in a user-level config file
instead of re-typing it on every invocation — a real env var on the command
line always wins over the file. It's a deliberately tiny flat subset of
YAML (`key: value` lines only, no nesting/lists), parsed with no added
dependency:

```yaml
# ~/.ccui-sbx.yml
CCUI_SBX_SKILLS_PLUGINS: "~/.claude/plugins/cache/se-skills/se-skills/0.3.0"
CCUI_SBX_NO_OPEN: "1"
```

A value starting with `~`/`~/` is tilde-expanded against `$HOME` (the file
itself is never shell-evaluated, so the shell doesn't do this for you).
Override the file's location with `CCUI_SBX_CONFIG=/path/to/file.yml`.

#### Making your own Claude plugin skills available inside the sandbox

A sandbox gets a brand-new, isolated `~/.claude` — it does not see your
host's installed plugins (e.g. anything from the `hivemind` or `se-skills`
marketplaces), since `sbx` has no mechanism to carry over a host's plugin
install state. `CCUI_SBX_SKILLS_PLUGINS` works around this for the skills
specifically (not the rest of a plugin — see caveat below):

```bash
CCUI_SBX_SKILLS_PLUGINS="$HOME/.claude/plugins/cache/se-skills/se-skills/0.3.0" ccui-sbx . ~/claude_work/kb
# Colon-separate multiple plugin directories:
CCUI_SBX_SKILLS_PLUGINS="$HOME/.claude/plugins/cache/se-skills/se-skills/0.3.0:$HOME/.claude/plugins/cache/hivemind/se-tools/1.1.13" ccui-sbx .
```

Each directory is mounted read-only, and every subfolder under its
`skills/` gets symlinked into the sandbox's `~/.claude/skills/` — the same
mechanism `sbx run --skills` already uses for a personal skills directory.
This is a **flat skill copy, not a real plugin install**: the skills
themselves work, but the plugin's own namespace prefix (e.g.
`se-skills:sbx-diagnose` shows up as bare `sbx-diagnose`) and any
`hooks.json` the plugin defines are not replicated.

#### Importing your real Claude Code session history into the sandbox

A sandbox also starts with no session history — none of your real Claude
Code conversations, whether run from the terminal CLI or from **Claude
Desktop's own "Claude Code" agent-mode feature** (both write the exact
same `~/.claude/projects/<cwd-folder>/<session-id>.jsonl` format; Desktop
isn't a separate storage system, just a different client writing to the
same files).

```bash
CCUI_SBX_IMPORT_HOST_SESSIONS=1 ccui-sbx .
# Or point at a different source directory instead of the real one:
CCUI_SBX_IMPORT_HOST_SESSIONS=1 CCUI_SBX_HOST_SESSIONS_DIR="$HOME/.claude/projects" ccui-sbx .
# Import-only, no write-back to your real history:
CCUI_SBX_IMPORT_HOST_SESSIONS=1 CCUI_SBX_HOST_SESSIONS_READONLY=1 ccui-sbx .
```

The sessions directory (default `~/.claude/projects`) is mounted
**read-write**, and each session is bind-mounted **individually** at its
own natural `~/.claude/projects/<folder-name>/<session-id>.jsonl` — not a
symlink (claudecodeui's own session-discovery code doesn't follow
symlinks, confirmed live), and not nested under any wrapper directory.
That second part matters more than it sounds: an earlier version of this
nested every imported session under one `.imported-host-sessions`
directory to dodge a folder-name collision, and that broke *resuming*
any imported session. The real `claude` CLI's own `--resume <session-id>`
does its own internal lookup from `cwd`, using the same folder-name
encoding claudecodeui's sync ignores — it has no idea a wrapper exists,
so it looks at the natural path and fails with "No conversation found",
even though the conversation's history was already visible and
browsable. Confirmed directly: copying a nested session's `.jsonl` to its
natural path made `--resume` work immediately; nested, it failed with
that exact message every time. Per-session mounting fixes this and
removes the need for the wrapper in the first place — a session id is a
UUID, so a host-imported file colliding with a pre-existing native one
would mean the exact same id existing twice, not just the same project
folder. A session's subagent/tool-result artifacts (a sibling directory
named after its own session id) are mounted too when present, so a
resumed session that used subagents or workflows still has them.

claudecodeui's own session sync already does a full scan at boot and a
live filesystem watch afterward, so existing history shows up
immediately and anything written later — from either side — shows up
within seconds, with no separate import step or background process.
Read-write also means a session you run *inside* the sandbox against a
project path that's already in your real history writes back into it
too; set `CCUI_SBX_HOST_SESSIONS_READONLY=1` if you don't want that.

**Importing history makes past conversations visible — it does not make
that project's files browsable** from inside the sandbox unless you also
mount that specific project directory (as the primary or an extra
workspace, same as always). An imported project you haven't also mounted
will show its conversation history but 404 on file-tree/terminal actions.

#### Scoping the import to only your mounted projects

By default, importing pulls in *every* project you've ever run Claude
Code against — not just the one or two you're working on in this
sandbox. `CCUI_SBX_HOST_SESSIONS_MOUNTED_ONLY=1` scopes it down:

```bash
CCUI_SBX_IMPORT_HOST_SESSIONS=1 CCUI_SBX_HOST_SESSIONS_MOUNTED_ONLY=1 ccui-sbx . ~/claude_work/kb
```

Only *sessions* (not whole folders) whose own `cwd` is this sandbox's
primary checkout or an extra mounted workspace (or a subdirectory of
one) get mounted — checked per session, not per folder, so a project
folder with sessions from two different working directories no longer
has to resolve that as all-or-nothing the way an earlier, folder-level
version of this did. Since every imported project's real folder is then
also mounted, this doesn't just filter noise — the file-tree/terminal
/git gap mentioned above doesn't apply to anything scoped this way.

"Mounted workspace" means exactly what `ccui-sbx` already treats as a
workspace path when it computes `CLOUDCLI_DEFAULT_PROJECT_PATH` — only
bare positional paths that appear *before* the first flag are picked up.
`ccui-sbx . --name foo ~/extra/path` silently won't see `~/extra/path`
here even though `sbx` may still mount it; put extra workspaces before
any flag if you want their history included.

### Option B: raw `sbx run`/`sbx create`

```bash
sbx create shell . --name ccui-dev --kit ./docker/sbx-kit
# or with the claude agent instead of a bare shell:
sbx create claude . --name ccui-dev --kit ./docker/sbx-kit

# open the ports the dev server needs
sbx ports ccui-dev --publish 3001:3001   # API / web UI
sbx ports ccui-dev --publish 5173:5173   # Vite client (HMR)
```

Then open http://localhost:3001.

Logs inside the sandbox:

```bash
sbx exec ccui-dev bash -lc 'tail -f /tmp/claudecodeui-install.log /tmp/claudecodeui-dev.log'
```

Note: `commands.startup` kits can only be applied at sandbox creation time
(`sbx create --kit` / `sbx run --kit`) — `sbx kit add` on an existing
sandbox is not supported for kits that declare startup commands.

## Testing this kit

```bash
npm run test:sbx-kit
```

Runs `docker/sbx-kit/tests/*.test.ts` against this kit's actual shipped
code — `ccui-sbx` as a real subprocess (against a stubbed `sbx` that just
records its argv) and each `spec.yaml` shell script extracted and run
against disposable fixtures (with `mount`/`mountpoint` faked, so no
root/CAP_SYS_ADMIN is needed). These aren't a hand-copied approximation:
a change to the shipped script or `spec.yaml` is what these tests exercise
directly, so they fail the moment the two diverge.

This covers everything that's practical to check without a real sandbox —
arg splicing, env threading, the `~/.ccui-sbx.yml` loader, and the mount
-matching/idempotency/failure-handling logic. It does not replace an
occasional live check in a real sandbox (`ccui-sbx .`) for anything that
depends on the actual kernel (bind mounts, `mountpoint`, CAP_SYS_ADMIN
under `commands.startup` specifically rather than an interactive `sbx
exec`) or the real `claude` CLI's own behavior (e.g. that `--resume`
actually finds a session at the path these tests assert it lands at).

One gap specifically worth flagging: the harness runs every script as a
single OS user, with no simulation of the real `user: "1000"` vs.
`user: "root"` split these steps rely on — so a permissions/ownership bug
across that split (root creating a file or directory the agent user later
can't write to) isn't something this suite can catch on its own, even
with 30 passing tests. `chown`/`mkdir` calls meant for the root-run steps
are faked so their *invocation* can still be asserted on (see
`chownLog` in the test harness), but nothing here enforces that an agent
-owned step could actually have performed the equivalent write — that
needs an occasional live check too.
