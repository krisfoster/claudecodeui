import assert from 'node:assert/strict';
import test from 'node:test';

import { AppError } from '@/shared/utils.js';

import { createAuthService } from '../auth.service.js';

type AuthDependencies = Parameters<typeof createAuthService>[0];

function createDependencies(overrides: Partial<AuthDependencies> = {}): AuthDependencies {
  return {
    users: {
      hasUsers: () => false,
      createUser: (username, passwordHash) => ({ id: 1, username, password_hash: passwordHash }),
      getUserByUsername: () => undefined,
      updateLastLogin: () => undefined,
    },
    transaction: {
      begin: () => undefined,
      commit: () => undefined,
      rollback: () => undefined,
    },
    hashPassword: async () => 'hashed-password',
    comparePassword: async () => false,
    generateToken: () => 'signed-token',
    ...overrides,
  };
}

test('register hashes credentials and commits through injected dependencies', async () => {
  const operations: string[] = [];
  const service = createAuthService(createDependencies({
    transaction: {
      begin: () => operations.push('begin'),
      commit: () => operations.push('commit'),
      rollback: () => operations.push('rollback'),
    },
    hashPassword: async (password) => {
      operations.push(`hash:${password}`);
      return 'hash';
    },
    users: {
      hasUsers: () => false,
      createUser: (username, passwordHash) => {
        operations.push(`create:${username}:${passwordHash}`);
        return { id: 1, username, password_hash: passwordHash };
      },
      getUserByUsername: () => undefined,
      updateLastLogin: (userId) => operations.push(`login:${userId}`),
    },
  }));

  const result = await service.register('alice', 'secret12');

  assert.equal(result.token, 'signed-token');
  // Hashing happens before begin() so nothing is ever awaited while the
  // transaction is open — see the comment in auth.service.ts.
  assert.deepEqual(operations, ['hash:secret12', 'begin', 'create:alice:hash', 'commit', 'login:1']);
});

test('register still returns success when the post-commit last-login write fails', async () => {
  const operations: string[] = [];
  const service = createAuthService(createDependencies({
    transaction: {
      begin: () => operations.push('begin'),
      commit: () => operations.push('commit'),
      rollback: () => operations.push('rollback'),
    },
    users: {
      hasUsers: () => false,
      createUser: (username, passwordHash) => ({ id: 1, username, password_hash: passwordHash }),
      getUserByUsername: () => undefined,
      updateLastLogin: () => {
        throw new Error('disk full');
      },
    },
  }));

  const result = await service.register('alice', 'secret12');

  assert.equal(result.success, true);
  // The account is already durably committed at this point — a failure
  // recording last-login must not roll back a transaction that no longer
  // exists or turn a successful registration into an error.
  assert.deepEqual(operations, ['begin', 'commit']);
});

test('register does not leave a transaction open across the hashPassword await', async () => {
  const operations: string[] = [];
  let releaseHash!: () => void;
  const hashGate = new Promise<void>((resolve) => {
    releaseHash = resolve;
  });

  const service = createAuthService(createDependencies({
    transaction: {
      begin: () => operations.push('begin'),
      commit: () => operations.push('commit'),
      rollback: () => operations.push('rollback'),
    },
    hashPassword: async (password) => {
      operations.push(`hash:${password}`);
      await hashGate;
      return 'hash';
    },
  }));

  const pending = service.register('alice', 'secret12');

  // While hashPassword is still pending, no transaction has been opened yet
  // — a concurrent register() call landing here would hit hasUsers() again,
  // not a nested begin() on an already-open transaction.
  assert.deepEqual(operations, ['hash:secret12']);

  releaseHash();
  await pending;

  assert.deepEqual(operations, ['hash:secret12', 'begin', 'commit']);
});

test('register seeds default preferences onto the new user when configured', async () => {
  const savedPreferences: Array<{ userId: number; updates: Record<string, unknown> }> = [];
  const service = createAuthService(createDependencies({
    preferences: {
      savePreferences: (userId, updates) => {
        savedPreferences.push({ userId, updates });
      },
    },
    defaultUserPreferences: {
      claudePermissions: { allowedTools: [], disallowedTools: [], skipPermissions: true },
    },
  }));

  await service.register('alice', 'secret12');

  assert.deepEqual(savedPreferences, [{
    userId: 1,
    updates: { claudePermissions: { allowedTools: [], disallowedTools: [], skipPermissions: true } },
  }]);
});

test('register seeds nothing when no default preferences are configured', async () => {
  let saveCalled = false;
  const service = createAuthService(createDependencies({
    preferences: {
      savePreferences: () => { saveCalled = true; },
    },
  }));

  await service.register('alice', 'secret12');

  assert.equal(saveCalled, false);
});

test('login rejects an invalid password without issuing a token', async () => {
  let tokenIssued = false;
  const service = createAuthService(createDependencies({
    users: {
      hasUsers: () => true,
      createUser: () => { throw new Error('unused'); },
      getUserByUsername: () => ({ id: 1, username: 'alice', password_hash: 'hash' }),
      updateLastLogin: () => undefined,
    },
    comparePassword: async () => false,
    generateToken: () => {
      tokenIssued = true;
      return 'token';
    },
  }));

  await assert.rejects(
    service.login('alice', 'wrong-password'),
    (error: unknown) => error instanceof AppError && error.code === 'AUTH_INVALID_CREDENTIALS',
  );
  assert.equal(tokenIssued, false);
});

test('refreshSession issues a replacement token for the authenticated user', () => {
  let tokenUser: { id: number | bigint; username: string } | undefined;
  const service = createAuthService(createDependencies({
    generateToken: (user) => {
      tokenUser = user;
      return 'replacement-token';
    },
  }));

  const result = service.refreshSession({ id: 7, username: 'alice' });

  assert.deepEqual(result, { token: 'replacement-token' });
  assert.deepEqual(tokenUser, { id: 7, username: 'alice' });
});
