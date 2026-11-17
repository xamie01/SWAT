import { describe, expect, it, vi } from 'vitest';
const native = vi.hoisted(() => ({ hash: vi.fn(async () => 'inert-hash'), verify: vi.fn(async () => false) }));
vi.mock('@node-rs/argon2', () => native);
import { hashToken, tokenMatches, parseApiKeyPrefix } from './credentials.js';

describe('credential primitives import safely beside custody without material generation', () => {
  it('does not invoke native password operations when imported or digesting inert tokens', () => {
    const digest = hashToken('inert-fixture-token');
    expect(tokenMatches(digest, hashToken('inert-fixture-token'))).toBe(true);
    expect(tokenMatches(digest, hashToken('other-inert-token'))).toBe(false);
    expect(native.hash).not.toHaveBeenCalled(); expect(native.verify).not.toHaveBeenCalled();
  });
  it('retains exact prefix parsing without generating credentials', () => {
    expect(parseApiKeyPrefix('swat_0123abcd_inert_fixture')).toBe('0123abcd');
    expect(parseApiKeyPrefix('swat_zzzzzzzz_inert_fixture')).toBeNull();
    expect(tokenMatches(Buffer.from('short'), Buffer.alloc(32))).toBe(false);
  });
});
