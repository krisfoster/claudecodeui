import assert from 'node:assert/strict';
import test from 'node:test';

import { AppError } from '@/shared/utils.js';

import { autoProvisionDefaultProject } from '../auto-provision-project.js';

type Dependencies = Parameters<typeof autoProvisionDefaultProject>[0];

function createDependencies(overrides: Partial<Dependencies> = {}): Dependencies {
  return {
    createProject: async () => undefined,
    ...overrides,
  };
}

test('does nothing when no project path is configured', async () => {
  let createCalled = false;
  const dependencies = createDependencies({
    createProject: async () => { createCalled = true; },
  });

  const result = await autoProvisionDefaultProject(dependencies, {});

  assert.equal(result, null);
  assert.equal(createCalled, false);
});

test('registers the configured path and returns it', async () => {
  const calls: string[] = [];
  const dependencies = createDependencies({
    createProject: async (projectPath) => { calls.push(projectPath); },
  });

  const result = await autoProvisionDefaultProject(dependencies, {
    projectPath: '/Users/kris/claude_work/KB',
  });

  assert.deepEqual(result, { projectPath: '/Users/kris/claude_work/KB' });
  assert.deepEqual(calls, ['/Users/kris/claude_work/KB']);
});

test('treats an already-registered project as a no-op, not a failure', async () => {
  const dependencies = createDependencies({
    createProject: async () => {
      throw new AppError('Project path already exists and is active', {
        code: 'PROJECT_ALREADY_EXISTS',
        statusCode: 409,
      });
    },
  });

  const result = await autoProvisionDefaultProject(dependencies, {
    projectPath: '/Users/kris/claude_work/KB',
  });

  assert.equal(result, null);
});

test('propagates any other createProject() failure to the caller', async () => {
  const dependencies = createDependencies({
    createProject: async () => {
      throw new AppError('Path exists but is not a directory', {
        code: 'PROJECT_PATH_NOT_DIRECTORY',
        statusCode: 400,
      });
    },
  });

  await assert.rejects(
    autoProvisionDefaultProject(dependencies, { projectPath: '/Users/kris/not-a-dir' }),
    (error: unknown) => error instanceof AppError && error.code === 'PROJECT_PATH_NOT_DIRECTORY',
  );
});
