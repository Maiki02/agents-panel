import { describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../src/db/index.js';
import { PasswordPolicyError, hashPassword, verifyPassword } from '../src/auth/password.js';
import { UserRepository } from '../src/auth/users.js';
import * as argon2 from '@node-rs/argon2';

vi.mock('@node-rs/argon2', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@node-rs/argon2')>();
  return { ...actual, verify: vi.fn(actual.verify) };
});

const GOOD = 'correct horse battery staple';

describe('password', () => {
  it('hashes with argon2id and verifies', async () => {
    const hash = await hashPassword(GOOD);
    expect(hash.startsWith('$argon2id$')).toBe(true);
    expect(await verifyPassword(hash, GOOD)).toBe(true);
    expect(await verifyPassword(hash, 'wrong password entirely')).toBe(false);
  });

  it('rejects passwords shorter than 14 characters', async () => {
    await expect(hashPassword('short-pass-13')).rejects.toBeInstanceOf(PasswordPolicyError);
    await expect(hashPassword('exactly-14-chrs')).resolves.toBeTypeOf('string');
  });

  it('returns false for a malformed stored hash', async () => {
    expect(await verifyPassword('not-a-hash', GOOD)).toBe(false);
  });
});

describe('UserRepository.verifyCredentials', () => {
  it('still runs an argon2id verification for unknown users', async () => {
    const users = new UserRepository(openDatabase(':memory:'));
    const spy = vi.mocked(argon2.verify);
    spy.mockClear();
    expect(await users.verifyCredentials('ghost', GOOD)).toBeUndefined();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('accepts the right password and rejects the wrong one', async () => {
    const users = new UserRepository(openDatabase(':memory:'));
    await users.create('alice', GOOD);
    expect((await users.verifyCredentials('ALICE', GOOD))?.username).toBe('alice');
    expect(await users.verifyCredentials('alice', 'another wrong password')).toBeUndefined();
  });
});
