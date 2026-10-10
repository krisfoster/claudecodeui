# Changes since forking from siteboon/claudecodeui

*What this fork added or changed relative to upstream, organized by theme rather than
by commit. Each change explains what it does, how it plugs into what already existed,
and what we found out building it, not just what the diff contains.*

## Scope and how this was compiled

This fork diverged from [siteboon/claudecodeui](https://github.com/siteboon/claudecodeui)
at commit `9212ee3` (2026-09-24). Everything below is drawn from the 34 content commits
between that point and the current `main` (18 merge commits were excluded, since they
carry no diff beyond the commits they merge). The commit messages in this repo are
unusually detailed, often including what was tried and rejected, what broke in testing,
and how a fix was verified live, so most of this document is a structured synthesis of
that record rather than new research. Where it helps, a commit hash is given so the full
message and diff can be read directly with `git show <hash>`.

Four themes cover the work:

1. [Sandbox-native development environment](#theme-1-sandbox-native-development-environment)
2. [Imported session history and resume reliability](#theme-2-imported-session-history-and-resume-reliability)
3. [Workspace path security hardening](#theme-3-workspace-path-security-hardening)
4. [Extend chat rendering capabilities](#theme-4-extend-chat-rendering-capabilities)

A short [supporting fixes](#supporting-fixes) section at the end covers the two commits
that do not fit any theme.

---

## Theme 1: Sandbox-native development environment

Docker Sandboxes became the primary way this fork gets developed and tested: a
disposable Linux environment that bind-mounts the checkout at its real host path and
runs the dev server from source, not from the published npm package. This theme is the
tooling that makes that environment usable with a single command instead of a checklist:
getting native modules to build for the sandbox's platform, logging in without a manual
setup form, and carrying over the host's real projects, skills, and session history.
All of it lives under `docker/sbx-kit/`, built as a Docker Sandboxes `kind: mixin` kit
plus a launcher script, `docker/sbx-kit/bin/ccui-sbx`.

### Run claudecodeui from source in a Docker Sandbox

*Commit `31de30ed`, plus a sandbox-naming fix in `382025af`.*

The kit installs native build tooling and rebuilds `better-sqlite3`, `node-pty`, and
`bcrypt` for the sandbox's platform, since the bind-mounted `node_modules` otherwise
carries over host-built binaries (this repo hit that exact problem repeatedly in later
work too: running `sbx exec` against a shared mount from a macOS host silently rebuilds
these as Linux binaries and breaks the host's own Node process until rebuilt back). It
also resolves the `claude` binary explicitly by checking `PATH` and a `CLAUDE_CLI_PATH`
override, because `sbx`'s startup-command dispatcher runs with a minimal `PATH` that
drops the image's own `/home/agent/.local/bin`, which otherwise fails every session with
"Claude Code native binary not found."

`ccui-sbx` wraps `sbx run claude`, attaches the kit, and publishes the dev server's
ports, falling back to an ephemeral host port when the default (3001/5173) is already
bound. It runs headless (`--detached`) by default so the interactive `claude` TUI never
swallows the port-publish output, printing a summary of resolved URLs instead;
`CCUI_SBX_ATTACH=1` restores the old attach-immediately behavior.

A later, small fix (`382025af`) found that the launcher's default sandbox name,
`basename($PWD)` alone, collided whenever two different checkouts shared a directory
name under different parents (e.g. `~/repos/claudecodeui` and `~/other/claudecodeui`).
The default now folds in a checksum of the full path.

A related dependency fix (`b915de7b`) is also effectively part of this change: 24
packages in `package-lock.json` had their `resolved` field pointing at
`registry.npmmirror.com` instead of `registry.npmjs.org`. npm fetches a locked package
from the exact URL in the lockfile regardless of the configured registry, and that
mirror was rejecting requests with 403 and resetting connections mid-download, which
reliably broke `npm install` in a fresh sandbox. Since the mirror serves the same
packages byte-for-byte, this was a straight URL substitution, verified with
`npm install --package-lock-only --dry-run` reporting no changes needed.

### Zero-touch sandbox login

*Commits `a5990d97`, `d4d5ba60`, `f0ba7587`, `f07d9c87`, `982081ed`.*

A fresh sandbox used to need a human at the browser to complete the first-run setup
form, which a disposable, headless environment usually doesn't have. This change gets
from `ccui-sbx .` to a logged-in session with no manual step.

`CLOUDCLI_AUTO_CREATE_ADMIN` (`d4d5ba60`) auto-creates one admin user on boot, with a
generated password (`crypto.randomBytes(16)`, the same idiom already used for the
JWT secret) printed once to stdout, both as a readable banner and as a fixed
`CLOUDCLI_ADMIN_PASSWORD=...` line for tooling to grep. `auto-provision-admin.ts` is a
pure function taking its dependencies as arguments rather than reading `process.env`
itself, matching a rule already established for the sibling skip-permissions setting
below, and it calls the existing `authService.register()` rather than reimplementing
hash-and-insert, so transaction safety and preference-seeding apply for free. It runs
once in `server/index.ts`'s `startServer()`, and a failure only warns: it never blocks
boot over what's ultimately a convenience feature. This also closed a real race an
earlier adversarial review had flagged: a sandbox reachable on a shared network before
its owner finished first-run registration was racing an untrusted party for the one
account. The commit message is explicit that the new trade (whoever reads stdout or the
log first gets the password) is a sandbox-appropriate one, not a production security
posture.

`CLOUDCLI_DEFAULT_CLAUDE_SKIP_PERMISSIONS` (`a5990d97`) separately seeds the new user's
Claude permission preference so sessions the web app spawns through the Agent SDK don't
prompt for approval on every tool call, matching the sandbox's own interactive
`--dangerously-skip-permissions` CLI session (that flag only ever applied to the direct
CLI invocation, not to SDK-spawned sessions). It only affects the one-time account
creation; an existing account's settings are never touched.

Two small fixes closed gaps in the above: `f0ba7587` added the missing `mkdir` before
the install snippet's symlink step, and fixed the startup summary hardcoding "admin"
even when `CLOUDCLI_ADMIN_USERNAME` overrides it. `f07d9c87` found that `ccui-sbx`'s grep
for the credential marker was anchored to the start of the line, but `npm run dev` runs
both processes through `concurrently`, which prefixes every line with `[0] `/`[1] `, so
the anchored pattern never matched and the password never reached the host terminal even
though the server printed it correctly. Confirmed directly against a running sandbox,
then fixed with an unanchored `grep -o` extraction.

`982081ed` closes the loop: `ccui-sbx` now opens the Vite client URL automatically (never
the API server's, which redirects to a literal `http://localhost:5173` that doesn't
resolve on the host) via `open`/`xdg-open`/`wslview`, falling back silently when none
exist or `CCUI_SBX_NO_OPEN=1` is set. When a fresh admin account was just created, the
opened URL carries `?username=&password=`, which `LoginForm.tsx` reads once on mount to
prefill the form (never auto-submits), then strips immediately via
`history.replaceState` so the plaintext credential sits in the address bar for as short
a time as possible. The password is also copied to the clipboard as a fallback.

### Auto-register and auto-open an extra mounted workspace as the default project

*Commits `431484d3`, `becfc36d`.*

`sbx` always bind-mounts a workspace at its exact host absolute path, for the primary
workspace and any extra one alike (confirmed: no `sbx` flag remaps that under
`/home/agent`). The app's default `WORKSPACES_ROOT` (the home directory) rejected every
one of those paths if you tried registering one by hand. The kit now sets
`WORKSPACES_ROOT=/` (depending on the bare-root fix described in
[Theme 3](#make-workspaces_root--actually-mean-unrestricted)), and `ccui-sbx` scans its
own leading positional arguments for a second workspace path, passing it through as
`CLOUDCLI_DEFAULT_PROJECT_PATH`. A new `auto-provision-project.ts`, shaped like the
admin-provisioning one above, registers it via the existing `createProject()` service at
boot, treating an already-registered path as a no-op so it's safe on every restart.
Verified end to end against a live two-workspace sandbox.

Registering it wasn't enough on its own (`becfc36d`): the client's existing auto-select
effect only fires when there is exactly one project total, so the new project never
opened automatically once any other project already existed, which is the normal case.
`GET /api/projects` now marks whichever project matches `CLOUDCLI_DEFAULT_PROJECT_PATH`
with `isDefault: true`, comparing after `realpath` resolution on both sides (comparing
the raw env var directly would silently miscompare on a symlinked path, caught live
on macOS's `/tmp` versus `/private/tmp`, not a theoretical concern). The client's
auto-select effect now prefers the `isDefault` project over the "exactly one" fallback.

### Mount host Claude plugin skills and add a sandbox config file

*Commit `2949184e`.*

A sandbox starts with a brand-new, isolated `~/.claude` with none of the host's
installed plugins, and `sbx` has no mechanism to carry over a host's plugin install
state. `CCUI_SBX_SKILLS_PLUGINS="dir1:dir2"` mounts one or more host plugin cache
directories read-only, and a new startup step symlinks every subfolder under each one's
`skills/` into the sandbox's `~/.claude/skills/`, the same mechanism `sbx run --skills`
already uses for a personal skills directory. This is explicitly a flat skill copy, not
a real plugin install: the skills work, but a plugin's own namespace prefix and any
`hooks.json` it defines are not replicated, since registering a full plugin would mean
hand-writing into `~/.claude/plugins/installed_plugins.json`, an undocumented internal
format judged too fragile to rely on.

The same commit adds `~/.ccui-sbx.yml` (override path `CCUI_SBX_CONFIG`) so any
`CCUI_SBX_*` variable can get a default there instead of being retyped on every
invocation; a real environment variable still wins. It is a deliberately tiny flat
subset of YAML, key-value lines only, parsed with `sed`/`grep` so it needs no added
dependency, with `~`-prefixed values tilde-expanded against `$HOME` since the file is
never shell-evaluated.

### Import and mirror the host's real Claude Code session history

*Commits `d05e70f6`, `8816bf89`, `6d90cf37`, `f8a0a138`.*

This is the largest and most iterated change in this theme: four rounds, each shipping
real functionality and each catching a real bug the previous round introduced, in two
separate adversarial reviews.

**Round 1 (`d05e70f6`).** `CCUI_SBX_IMPORT_HOST_SESSIONS=1` mounts the host's
`~/.claude/projects` (or an override directory) into the sandbox read-write. Both the
terminal `claude` CLI and Claude Desktop's own agent-mode write the identical
`~/.claude/projects/<cwd-folder>/<session-id>.jsonl` format, confirmed by matching a
Desktop session's `cliSessionId` to a real file on disk, so no new application code was
needed: claudecodeui's existing session sync already does a full boot-time scan and a
live filesystem watch. A plain symlink was tried first and silently failed: the sync's
`findFilesRecursivelyCreatedAfter` and the sessions watcher (`chokidar`'s
`followSymlinks: false`) both skip symlinked directory entries, so the mirror was
completely invisible to the app's own discovery with no error anywhere. Switched to a
real `mount --bind` instead, `mkdir` as the agent user for ownership, then the bind
mount as root since that step needs `CAP_SYS_ADMIN`. Validated against 295 real
projects live, including a write from inside the sandbox propagating back to the host.

**Round 2 (`8816bf89`).** Unscoped import showed every project ever used, including ones
whose real folder isn't mounted in this sandbox, and using that dangling history failed
differently depending on which panel you tried: a clean 404 from the file tree, a clean
websocket error from the terminal, an unhelpful generic 500 from the git panel.
`CCUI_SBX_HOST_SESSIONS_MOUNTED_ONLY=1` scopes the import to project folders whose own
sessions' `cwd` is the sandbox's primary checkout, an extra mounted workspace, or a
subdirectory of one. `cwd` is sampled directly out of each folder's own `.jsonl`
content, the same ground truth the app's own synchronizer already trusts, rather than
re-deriving Claude's folder-name encoding (which collapses `/`, `.`, and `_` all to `-`
and would be lossy to reverse). Matching uses a literal, non-glob prefix strip
(`${var#"$pattern"}`), confirmed empirically in both `sh` and `dash` to treat a quoted
pattern as a literal string, so a path containing `*`, `?`, or `[` can't cause a false
match. Verified with 8 standalone test cases and a live run showing exactly one project
via `/api/projects` instead of 295+.

**Round 3 (`6d90cf37`).** An independent adversarial review of round 2 caught several
real bugs before they were exercised in practice: mounting each matched folder directly
at its natural `~/.claude/projects/<folder-name>` used the exact path the sandbox's own
native Claude Code usage would write to, silently shadowing any real session history
already there. Reverted to nesting under `.imported-host-sessions/<folder-name>`, losing
nothing since which project a session belongs to comes from its own `cwd` field, never
from where the transcript physically sits. The symlink-resolution logic used a logical
`pwd` for the mounted-workspace paths, but a session's recorded `cwd` is the kernel's
physical `getcwd()` with symlinks already resolved, so it was switched to `pwd -P`
(macOS's `/tmp` to `/private/tmp` is the case this matters for). `set -e` was also
confirmed, empirically, to kill an entire shell loop on any single failing command, not
just that iteration, so each mount attempt is now guarded to skip and warn instead of
aborting the whole scan. The `/proc/mounts` idempotency check was swapped for
`mountpoint -q`, and the whole scan was measured at about 6.35 seconds against a real
299-folder history, then backgrounded so it doesn't block dev-server startup (the app's
own filesystem watch already handles directories that appear late).

**Round 4 (`f8a0a138`).** A second adversarial review, this time of a merged PR already
believed done, caught a real regression confirmed by reproducing it in a real container:
the root-run mount step creates each project's folder with `mkdir -p` as root, since
bind mounts need `CAP_SYS_ADMIN`. Unlike the session files mounted inside it, that
folder itself is never overlaid by anything, so it stayed root-owned forever, silently
blocking the sandbox's own native `claude` CLI from ever writing a new file into a
project whose history had been imported. Fixed with a guarded `chown 1000:1000` right
after the folder is created.

Across all four rounds, the feature's own test coverage, built incrementally (see
[Change 2.2](#fix-resuming-imported-sessions-default-to-the-flat-conversations-view-and-add-an-sbx-kit-test-harness)),
grew from nothing to a shared harness that runs the actual shell scripts as real
subprocesses, which is what let rounds 2 through 4 be re-verified in seconds rather than
by hand each time.

---

## Theme 2: Imported session history and resume reliability

Importing host session history (Theme 1) surfaced two problems that are really about
the core app's robustness, not about sandbox plumbing specifically: resuming a session
whose history came from somewhere else, and presenting a project-folder-shaped sidebar
to conversations that may not have a usable project folder at all.

### Clear error when a session's project folder is missing

*Commit `9cee57d6`.*

An imported session carries a real `cwd`, but that folder may never have been mounted
into this environment. Node's `spawn()` then fails with `ENOENT` against the missing
`cwd`, and the Claude Agent SDK's own error formatting misreports that as "Claude Code
native binary ... exists but failed to launch," since it only checks that the
executable file exists, never the working directory. This was reproduced directly:
spawning the same binary with a valid `cwd` exits 0, with a nonexistent one it fails
with `ENOENT`, and the SDK's wrapper can't tell the two apart. `queryClaudeSDK` now
checks the `cwd` exists as a directory before ever reaching the SDK, throwing a clear,
actionable message instead, through the same error-reporting path already used for
"Claude Code is not installed." The external agent-run HTTP API already had its own
separate guard and was unaffected; this specifically covers the WebSocket-driven chat
path, which had none.

### Fix resuming imported sessions, default to the flat Conversations view, and add an sbx-kit test harness

*Commit `850f2369`, described in its own message as three related pieces of work from
one investigation thread.*

**Resuming was silently broken.** The real `claude` CLI's `--resume <session-id>` does
its own internal lookup from the current working directory, using the same folder-name
encoding the app's own sync ignores. Nesting every imported session under one
`.imported-host-sessions` wrapper, done in round 3 above specifically to dodge a
folder-name collision with the sandbox's own native sessions, left the CLI unable to
find anything there: it looks at the natural path and fails with "No conversation
found," even though the conversation's history was already visible and browsable in the
UI. The fix bind-mounts each session file individually at its own natural
`~/.claude/projects/<folder>/<session-id>.jsonl`, plus its subagent and tool-result
artifacts when present, with no wrapper directory at all, since a session id is a UUID
and the only real collision would mean the exact same id existing twice.

**The sidebar now defaults to the flat view.** The existing "Conversations" tab, a
flat, chat-first list across all projects, became the default instead of the
project-grouped tree, since the chat is the primary unit a user is looking for and the
project name is secondary context under it, not a grouping header above it. Sessions
whose project folder isn't available here (common for imported history whose folder was
never mounted) are now marked explicitly instead of failing silently when opened.

**Real automated test coverage.** The sbx-kit scripting built across this whole theme
had, until this point, only manual and thrown-away verification. A new shared harness
under `docker/sbx-kit/tests/` runs `spec.yaml`'s actual shell scripts and `ccui-sbx`
itself as real subprocesses against disposable fixtures, with `mount`/`mountpoint`
faked so no root is needed. Thirty tests cover whole-tree and mounted-only matching, the
equal-or-descendant workspace check (including the macOS symlink case `pwd -P` was
added for), idempotent re-runs, one mount failure not aborting the rest, the
`~/.ccui-sbx.yml` loader, and argument-splicing around a trailing `--`. Wired up as
`npm run test:sbx-kit`.

---

## Theme 3: Workspace path security hardening

A focused review of `validateWorkspacePath` (`server/shared/utils.ts`), the single
containment check every project-registration path is supposed to go through, found both
a logic bug in the check itself and several places that had drifted away from using it
at all. The review was prompted directly by Theme 1's `WORKSPACES_ROOT=/` configuration,
which pushed the containment logic into edge cases (a bare filesystem root as the
configured root) that had never previously mattered.

### Make `WORKSPACES_ROOT=/` actually mean unrestricted

*Commits `0379c032`, `273541de`.*

`validateWorkspacePath` built `${resolvedWorkspaceRoot}${path.sep}` as the required path
prefix. When `WORKSPACES_ROOT` resolves to a bare filesystem root, that expression
becomes `//`, a prefix no normalized absolute path ever starts with, so it silently
rejected every workspace path instead of meaning "no containment restriction beyond
`FORBIDDEN_WORKSPACE_PATHS`." The fix special-cases the bare-root case: when the
resolved root equals its own `path.parse(...).root`, the containment check is skipped
entirely, since every absolute path is trivially under its own filesystem root by
definition. `FORBIDDEN_WORKSPACE_PATHS` still applies regardless, so the system-directory
floor is unchanged; only the redundant check on top of it is removed.

Separately, the configured root's own subtree could get vetoed by
`FORBIDDEN_WORKSPACE_PATHS` if it happened to collide with a generically forbidden-looking
path, for example `WORKSPACES_ROOT=/root`, common for anything running as root in a
container. The app's own default landing spot was rejected with "Cannot use
system-critical directories as workspace locations" the moment the folder browser
opened. The configured root's own subtree is now exempted, with two things kept intact
so this doesn't swallow the protection entirely: a bare `/` is never exempt even when it
is the configured root, so registering the entire filesystem stays blocked
unconditionally, and when `WORKSPACES_ROOT` itself is a bare root, nothing is exempted at
all, since applying `FORBIDDEN_WORKSPACE_PATHS` to everything is the whole point of that
configuration. This fix also moved the input path's `realpath` resolution earlier and
compared it against the resolved root consistently on both sides; comparing an
unresolved input against a resolved root silently miscompares whenever either is a
symlink, which is how the new root-collision path was actually exercised in testing,
using `/tmp` as a portable stand-in for `/root` since `/root` doesn't exist on a
non-Linux development machine.

### Close per-endpoint containment-check bypasses

*Commits `89b8b55c`, `37b3ac3b`, `c006d41b`.*

Three places registered or used a project path without going through
`validateWorkspacePath` at all.

The external agent-run API's direct-`projectPath` branch (as opposed to its
`githubUrl`/clone branch, which already validated) only checked that the path existed
on disk, never the containment check `createProject()` enforces everywhere else a
project is registered. An API-key-authenticated caller, a different trust boundary than
a logged-in browser session, could point an agent at any readable directory, including
the ones `FORBIDDEN_WORKSPACE_PATHS` exists specifically to block. The validator is now
an injected dependency on the router, matching its existing pattern for other
dependencies, wired to the real check in production and a permissive stub in tests
(needed because `WORKSPACES_ROOT` is a module-level constant resolved from the
environment at import time, so a test can't just set `process.env` and expect it to
take effect).

`git.routes.ts` maintained an entirely separate, narrower containment check that only
ever rejected the literal bare filesystem root, never `FORBIDDEN_WORKSPACE_PATHS` or
`WORKSPACES_ROOT`. It had already silently diverged once: the bare-root fix above never
propagated here, since there was no shared code for it to propagate through. Its only
caller was already async, so delegating fully to `validateWorkspacePath` was a drop-in
change, leaving no second implementation to drift out of sync again.

`shell-websocket.service.ts` accepted any existing directory as a terminal session's
starting `cwd`, with no containment check at all. This one is called out explicitly as
not quite the same kind of security boundary as the others: a shell can `cd` anywhere
the OS permits once it starts, so mirroring `validateWorkspacePath` here would be
security theater that a single `cd ..` defeats. The actual, available fix is a coherence
one: the incoming path must match an already-registered project, since the Shell tab
only ever sends the path of a project already in the sidebar.

### Fix `~` expanding to a hard-forbidden path

*Commit `5f1805b4`.*

A direct consequence of `WORKSPACES_ROOT=/`: `expandWorkspacePath` resolved `~` to
`WORKSPACES_ROOT` verbatim, which is fine normally, but with the sandbox's root set to
`/`, `~` expanded to the literal bare filesystem root, which `validateWorkspacePath`
always hard-blocks on purpose. The folder browser's own default view was rejected the
instant it opened, reported at the time as "half a fix, in fact it's worse." `~` now
falls back to the real `os.homedir()` specifically when the configured root is a bare
filesystem root, leaving every other `WORKSPACES_ROOT` value's behavior unchanged.

---

## Theme 4: Extend chat rendering capabilities

Mermaid diagram rendering already existed upstream. This fork added Vega-Lite charts,
sortable and filterable tables, sandboxed D3 visualizations, inline images from the
`Read` tool, a system-prompt addition so the model knows these exist at all, and
click-to-zoom across the diagram and chart renderers. Several of these shipped once,
then needed real fixes once they met production conditions the original tests hadn't
covered, which is a theme in itself worth calling out directly: adversarial review and
live verification against the real app repeatedly caught bugs that a green test suite
had missed.

### Render Mermaid, Vega-Lite, and D3 inline, and add sortable tables

*Commits `234c9146`, `0082df01`, `55aadb5d`.*

`VegaLiteChart.tsx` (`234c9146`) lazy-loads `vega-embed` on first use and falls back to
raw source on invalid or incomplete JSON, or a render failure, the same trust boundary
and fallback philosophy as the existing Mermaid renderer: Claude writes a declarative
spec, the client calls the charting library itself, never arbitrary code. It was wired
into both places Mermaid already rendered, chat's `Markdown.tsx` and the code editor's
`MarkdownCodeBlock.tsx`, for parity. The same commit replaced the plain `table` markdown
override with `RichTable`, giving any GFM table Claude already writes client-side sort
and filter with no new syntax to learn; it reorders already-rendered `<tr>` elements
rather than re-rendering cell content, so links, bold text, and code inside cells
survive untouched.

`D3Sandbox.tsx` (`0082df01`) is a different trust problem: D3 is Claude-authored code,
not a declarative spec, so it cannot run in the app's own origin without handing
untrusted, prompt-injectable JavaScript full access to the user's session. The fenced
block's body becomes the body of `render(container, d3, width, height)`, executed inside
an iframe with `sandbox="allow-scripts"`, no `allow-same-origin`, and a CSP blocking all
network access. A syntax pre-check (`new Function(...)`, compiled but never invoked)
runs in the parent before the iframe is ever touched, so a still-streaming, incomplete
snippet doesn't reload a 280KB bundle on every rendering tick. D3's own `package.json`
only exposes a bare `"."` export specifier, with no subpath for its dist file, so a new
Vite plugin (`shared/d3BundlePlugin.js`) resolves a virtual module id to the real file on
disk instead.

An adversarial review (`55aadb5d`) found the D3 sandbox, as first committed, never
actually rendered anything in a real browser: its CSP allowed `'unsafe-inline'` but not
`'unsafe-eval'`, which blocks the harness's own `new Function(...)` call under any real
CSP-enforcing browser. jsdom does not enforce CSP at all, so the full test suite passed
without ever exercising this path. The same review found that `JSON.stringify` escapes
quotes but not `<`, so a literal `</script>` inside the fenced block's own source closed
the harness's own `<script>` tag early, leaving any markup after it as untrusted sibling
content in the sandboxed document. Both were fixed (`'unsafe-eval'` added, `<` escaped to
`<` before interpolation), alongside `navigate-to 'none'` as defense in depth and an
`unhandledrejection` listener so an async failure reports back immediately instead of
waiting out the five-second render timeout. New tests pin the CSP keywords and the
escaping directly against the generated `srcDoc`, not just the rendered outcome, so a
regression here cannot hide behind jsdom's lack of CSP enforcement again.

### Tell the model these renderers exist

*Commits `90fe10fb`, `d0fa04fb`.*

Nothing told a session that the chat transcript renders these fences specially instead
of as plain text, so asked for a diagram, the model would default to writing a
standalone HTML file into the repository instead, having no reason to know a better
option existed. A description of each renderer and its constraints (Vega-Lite needs
inline data, not a `data.url`; D3 runs sandboxed with no network and no page access) is
now appended to every session's system prompt via the SDK's `systemPrompt.append` field,
on top of the existing `claude_code` preset, applying regardless of the mounted
project's own `CLAUDE.md`. The feature itself had also shipped with no end-user
documentation anywhere in the repository beyond that internal prompt string, which the
second commit fixed with a Features bullet and a dedicated README section covering the
fence syntax and constraints for each renderer.

### Render tool-read images inline in chat

*Commits `13da3107`, `41e95357`, `8e31b6ce`, `735af9a4`.*

The `Read` tool's result is hidden by default, since raw file content has nowhere
useful to render, but that also swallowed image reads: the model could only describe a
picture in text, with no way for the user to actually see it (for example, asking it to
show an image asset already in the repository). The fix (`13da3107`) checks the file
extension in the `Read` call's input and, when it is an image, keeps the result visible
and renders it through `MarkdownImage`, the same workspace-path blob-fetch and lightbox
component already used for images the model references in its own markdown text. This
reuses an existing fetch path rather than the SDK's own base64 tool-result payload,
which sidesteps a truncation concern: tool output is capped by length server-side, which
would otherwise corrupt a large embedded image.

Three more commits were needed before this actually worked, each one a genuine
production bug a green test suite had not caught:

- `41e95357` found that when `Read` downscales a large image for the model, the CLI
  injects a standalone turn whose entire content is a coordinate-mapping note for its
  own benefit, for example `[Image: original 2972x1440, displayed at 2000x969.
  Multiply coordinates by 1.49 to map to original image.]`. Left unfiltered, this
  rendered as a confusing, unexplained text bubble in the transcript. It was filtered in
  `normalizeMessageRows`, the single function both the live stream and historical
  transcript loading call through.
- `8e31b6ce` found that the first fix had filtered the wrong branch. It assumed the
  caption arrived as an assistant-role message, based on a bare `claude --print`
  capture that mislabeled the role during manual inspection. Reproducing through the
  actual Agent SDK `query()` path, the code path the real app uses, showed the true
  shape: a synthetic **user**-role turn carrying the SDK's own documented
  `isSynthetic: true` flag. The real filter is gated on both the content pattern and
  that flag, so a human who happened to type matching text is never silently dropped.
- `735af9a4` found that the image preview still did not work outside its own unit
  tests. The frontend's message-merge step JSON-stringifies a tool call's input when
  combining the backend's separate `tool_use` and `tool_result` websocket messages into
  one displayable message, so by the time the image check ran, the input was a string,
  not an object, and reading `.file_path` off it was always `undefined`. The original
  tests had passed the input as a plain object directly, bypassing the real merge step
  entirely, so they stayed green while the actual app silently failed. The fix parses
  the input with the same helper the tool's input chip already used, and a new
  end-to-end test drives the real merge function instead of a hand-shaped fixture, which
  is what should have caught this the first time.

### Click-to-zoom for diagrams, charts, and D3 visualizations

*Commit `d1441b0e`.*

Diagrams and charts had no way to be seen larger, unlike images, which already open a
fullscreen lightbox on click. Each renderer now shows a hover-reveal zoom icon rather
than a whole-surface click target, since Vega-Lite charts already have their own hover
tooltips that a whole-surface click would compete with. Clicking opens a large dialog
built on the existing `Dialog` primitive, already used by four other modules for its
portal, backdrop click, Escape handling, focus trap, and scroll lock, rather than the
simpler, purpose-built `ImageLightbox` component, which has none of those. Images
themselves were left untouched.

Zooming mounts a second, independent instance of the same renderer component rather
than portal-moving or CSS-scaling the existing one. For Vega-Lite, this is what keeps
the chart genuinely interactive when zoomed: a fresh `vega-embed` call creates its own
live view with its own event listeners, which a screenshot or a portal-moved canvas
could not guarantee. This was verified as safe for two simultaneous instances by reading
the actual library source rather than assuming it: `vega-scenegraph`'s SVG clip-path and
gradient ids are page-global, monotonically increasing counters that are never reset
automatically, so two live views cannot collide regardless of identical specs, and
Mermaid's `useId()`-based render ids correctly prefix every internal element id it
generates, isolating two simultaneous diagrams the same way.

Building this surfaced three further bugs in the pre-existing D3 sandbox, all
independently correct fixes, not just zoom-specific ones: the sandboxed document's
injected CSS never gave itself a height, so `container.clientHeight`, passed into the
model's own `render()` call, was meaningless regardless of how large the outer iframe
became; the existing `d3-resize` postMessage's `height` payload was dead data, sent by
the sandbox but never read by the parent, now wired into the iframe's actual
`style.height`; and the sandboxed iframe is a genuinely separate document, so a keydown
while interacting inside it never reached the parent's Escape handler, now relayed
through a new `d3-escape` postMessage instead.

---

## Supporting fixes

One test-infrastructure fix does not belong to any of the themes above but is worth a
line: Node 22's own experimental global `localStorage`/`sessionStorage` resolves to
`undefined` without an explicit `--localstorage-file`, and wins over jsdom's own working
implementation in the test environment, since both resolve to the exact same global. Any
test whose `beforeEach` called `localStorage.clear()` failed with "Cannot read
properties of undefined," which had been worked around or dismissed several times
earlier in this fork's history as a pre-existing, unrelated environment quirk rather
than fixed. `--no-experimental-webstorage` on the vitest process, via `cross-env`,
restores jsdom's `localStorage` as the only implementation, and every previously-failing
test across the client suite passed with no other change (`cc6aa90e`).
