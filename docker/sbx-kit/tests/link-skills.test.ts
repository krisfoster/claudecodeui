import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { homeAgentPath, loadKitScript, runKitScript } from './kitScriptHarness.js';

/**
 * Exercises `.claude-link-skills.sh` (CCUI_SBX_SKILLS_PLUGINS) directly from
 * spec.yaml's own content. Unlike the host-sessions mount, this one
 * symlinks (claudecodeui's skill discovery, unlike its session discovery,
 * explicitly follows symlinks — see findProviderSkillMarkdownFiles), so the
 * fake `mount`/`mountpoint` stubs aren't involved here at all.
 */

const SCRIPT = loadKitScript('link-skills');

function makeSkillPlugin(pluginDir: string, skillNames: string[]): void {
  for (const skillName of skillNames) {
    const skillDir = path.join(pluginDir, 'skills', skillName);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(path.join(skillDir, 'SKILL.md'), `# ${skillName}\n`);
  }
}

test('CLOUDCLI_EXTRA_SKILLS_DIRS unset is a clean no-op', () => {
  const result = runKitScript(SCRIPT);
  try {
    assert.equal(result.exitCode, 0);
  } finally {
    result.cleanup();
  }
});

test('links every skill from a single plugin directory', () => {
  const result = runKitScript(SCRIPT, {
    setup: (root) => makeSkillPlugin(path.join(root, 'plugin-a'), ['skill-one', 'skill-two']),
    env: (root) => ({ CLOUDCLI_EXTRA_SKILLS_DIRS: path.join(root, 'plugin-a') }),
  });
  try {
    const linkOne = homeAgentPath(result, '.claude', 'skills', 'skill-one', 'SKILL.md');
    const linkTwo = homeAgentPath(result, '.claude', 'skills', 'skill-two', 'SKILL.md');
    assert.ok(existsSync(linkOne));
    assert.ok(existsSync(linkTwo));
    assert.equal(readFileSync(linkOne, 'utf8'), '# skill-one\n');
  } finally {
    result.cleanup();
  }
});

test('links skills from multiple colon-joined plugin directories', () => {
  const result = runKitScript(SCRIPT, {
    setup: (root) => {
      makeSkillPlugin(path.join(root, 'plugin-a'), ['skill-one']);
      makeSkillPlugin(path.join(root, 'plugin-b'), ['skill-three']);
    },
    env: (root) => ({
      CLOUDCLI_EXTRA_SKILLS_DIRS: `${path.join(root, 'plugin-a')}:${path.join(root, 'plugin-b')}`,
    }),
  });
  try {
    assert.ok(existsSync(homeAgentPath(result, '.claude', 'skills', 'skill-one')));
    assert.ok(existsSync(homeAgentPath(result, '.claude', 'skills', 'skill-three')));
  } finally {
    result.cleanup();
  }
});

test('a plugin directory with no skills/ subfolder is skipped cleanly', () => {
  const result = runKitScript(SCRIPT, {
    setup: (root) => mkdirSync(path.join(root, 'plugin-empty'), { recursive: true }),
    env: (root) => ({ CLOUDCLI_EXTRA_SKILLS_DIRS: path.join(root, 'plugin-empty') }),
  });
  try {
    assert.equal(result.exitCode, 0);
  } finally {
    result.cleanup();
  }
});

test('re-linking the same plugin is idempotent (ln -sfn overwrites, does not error)', () => {
  const result = runKitScript(SCRIPT, {
    setup: (root) => makeSkillPlugin(path.join(root, 'plugin-a'), ['skill-one']),
    env: (root) => ({ CLOUDCLI_EXTRA_SKILLS_DIRS: path.join(root, 'plugin-a') }),
  });
  try {
    const second = spawnSync('sh', [path.join(result.root, 'script.sh')], {
      env: {
        PATH: process.env.PATH ?? '',
        HOME: homeAgentPath(result),
        CLOUDCLI_EXTRA_SKILLS_DIRS: path.join(result.root, 'plugin-a'),
      },
    });
    assert.equal(second.status, 0);
  } finally {
    result.cleanup();
  }
});
