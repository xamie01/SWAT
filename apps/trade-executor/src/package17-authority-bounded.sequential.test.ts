import { describe, expect, it } from 'vitest';
import {
  createExecutionAuthorityAdapters,
  createUserSolanaAuthority,
  type OperatorAuthorityDeps,
  type UserSolanaAuthorityOptions
} from './execution-authority-adapters.js';
import {
  createExecutionAuthorityRegistry,
  type ExecutionAuthorityRequest
} from './execution-authority.js';

// Only the real pure authority constructors/registry are imported. No SDK,
// executor entrypoint, shared runtime barrel, key, service or signing fixture.
const userRequest: ExecutionAuthorityRequest = {
  chain: 'solana', principal: { kind: 'user', userId: 'bounded-user' }, action: 'venue-trade'
};

function inertOperatorDeps() {
  const calls = { solanaAddress: 0, solanaSigner: 0, evmAddress: 0, evmSigner: 0, pmIdentity: 0, pmSigner: 0 };
  const deps: OperatorAuthorityDeps = {
    solana: {
      trojanWalletAddress: () => { calls.solanaAddress++; return 'opaque-operator-account'; },
      signer: () => { calls.solanaSigner++; return null; }
    },
    robinhoodChain: {
      accountAddress: () => { calls.evmAddress++; return 'opaque-evm-account'; },
      typedDataSigner: () => { calls.evmSigner++; return null; }
    },
    polygon: {
      identity: () => { calls.pmIdentity++; return { signerAddress: 'opaque-pm-signer', funderAddress: 'opaque-pm-funder' }; },
      typedDataSigner: () => { calls.pmSigner++; return null; }
    }
  };
  return { deps, calls };
}

const boundaries = [
  {
    name: 'direct user constructor',
    create(options?: UserSolanaAuthorityOptions) {
      return createUserSolanaAuthority(options).authorize;
    }
  },
  {
    name: 'registered adapter factory',
    create(options?: UserSolanaAuthorityOptions) {
      return createExecutionAuthorityRegistry(createExecutionAuthorityAdapters(inertOperatorDeps().deps, options));
    }
  }
];

describe('bounded unavailable user-Solana authority', () => {
  for (const boundary of boundaries) {
    describe(boundary.name, () => {
      it.each(['programId', 'enabled', 'signer', 'loadUserVaultAddress'] as const)(
        'refuses before accessing the %s option getter', async property => {
          let reads = 0;
          const options: UserSolanaAuthorityOptions = Object.defineProperty({}, property, {
            enumerable: true,
            get() { reads++; throw new Error(`forbidden-option-read:${property}`); }
          });
          const resolve = boundary.create(options);
          expect(await resolve(userRequest)).toMatchObject({
            kind: 'denied', code: 'authority-solana-delegate-unavailable'
          });
          expect(reads).toBe(0);
        }
      );

      it('refuses without inspecting, enumerating or copying proxied options', async () => {
        const calls = { get: 0, ownKeys: 0, descriptor: 0 };
        const options = new Proxy<UserSolanaAuthorityOptions>({}, {
          get() { calls.get++; throw new Error('forbidden-options-get'); },
          ownKeys() { calls.ownKeys++; throw new Error('forbidden-options-enumeration'); },
          getOwnPropertyDescriptor() { calls.descriptor++; throw new Error('forbidden-options-descriptor'); }
        });
        expect(await boundary.create(options)(userRequest)).toMatchObject({
          kind: 'denied', code: 'authority-solana-delegate-unavailable'
        });
        expect(calls).toEqual({ get: 0, ownKeys: 0, descriptor: 0 });
      });

      it('does not treat an injected signer or fabricated vault identity as deployed authority', async () => {
        const calls = { sign: 0, tip: 0 };
        const resolve = boundary.create({
          enabled: true,
          programId: 'opaque-unverified-program',
          signer: {
            publicKey: 'opaque-inert-signer',
            async sign() { calls.sign++; throw new Error('signing-forbidden'); },
            async buildTip() { calls.tip++; throw new Error('tip-signing-forbidden'); }
          }
        });
        const verdict = await resolve(userRequest);
        expect(verdict).toMatchObject({ kind: 'denied', code: 'authority-solana-delegate-unavailable' });
        expect(verdict).not.toHaveProperty('authority');
        expect(calls).toEqual({ sign: 0, tip: 0 });
      });

      it('does not resolve a signer, read its public key or resolve a vault', async () => {
        const calls = { signer: 0, publicKey: 0, vault: 0, sign: 0, tip: 0 };
        const signer = {
          get publicKey(): string { calls.publicKey++; throw new Error('public-key-read-forbidden'); },
          async sign() { calls.sign++; throw new Error('signing-forbidden'); },
          async buildTip() { calls.tip++; throw new Error('tip-signing-forbidden'); }
        };
        const resolve = boundary.create({
          enabled: true,
          signer: () => { calls.signer++; return signer; },
          loadUserVaultAddress: async () => { calls.vault++; return 'opaque-unverified-vault'; }
        });
        expect(await resolve(userRequest)).toMatchObject({
          kind: 'denied', code: 'authority-solana-delegate-unavailable'
        });
        expect(calls).toEqual({ signer: 0, publicKey: 0, vault: 0, sign: 0, tip: 0 });
      });

      it.each([undefined, false, true])('cannot enable authority with enabled=%s', async enabled => {
        expect(await boundary.create({ enabled })(userRequest)).toMatchObject({
          kind: 'denied', code: 'authority-solana-delegate-unavailable'
        });
      });

      it.each(['venue-trade', 'token-spend-permission', 'position-redemption'] as const)(
        'keeps keyless %s requests unavailable, not synthetic discovery grants', async action => {
          const verdict = await boundary.create()({ ...userRequest, action });
          expect(verdict).toMatchObject({ kind: 'denied', code: 'authority-solana-delegate-unavailable' });
          expect(verdict).not.toHaveProperty('authority');
          if (verdict.kind !== 'denied') throw new Error('unexpected-authority-grant');
          expect(verdict.reason).toMatch(/unavailable|unverified|not verified/i);
          expect(verdict.reason).toContain('S4-P12');
          expect(verdict.reason).toContain('ADR-0003');
          expect(verdict.reason).toContain('user:bounded-user');
        }
      );
    });
  }

  it('preserves user adapter shape and never serves the operator', () => {
    const authority = createUserSolanaAuthority();
    expect(authority.id).toBe('user-solana');
    expect(authority.chain).toBe('solana');
    expect(authority.serves(userRequest.principal)).toBe(true);
    expect(authority.serves({ kind: 'operator' })).toBe(false);
    expect(Object.keys(authority).sort()).toEqual(['authorize', 'chain', 'id', 'serves']);
  });

  it('does not touch operator dependencies while constructing or refusing a user request', async () => {
    const { deps, calls } = inertOperatorDeps();
    const adapters = createExecutionAuthorityAdapters(deps);
    expect(adapters).toHaveLength(6);
    expect(await createExecutionAuthorityRegistry(adapters)(userRequest)).toMatchObject({
      kind: 'denied', code: 'authority-solana-delegate-unavailable'
    });
    expect(calls).toEqual({ solanaAddress: 0, solanaSigner: 0, evmAddress: 0, evmSigner: 0, pmIdentity: 0, pmSigner: 0 });
  });

  it.each([
    ['solana', 'operator-solana', 'opaque-operator-account', null, 'venue-trade'],
    ['robinhood-chain', 'operator-robinhood-chain', 'opaque-evm-account', 'opaque-evm-account', 'token-spend-permission'],
    ['polygon', 'operator-polymarket', 'opaque-pm-funder', 'opaque-pm-signer', 'position-redemption']
  ] as const)('preserves the keyless %s operator adapter without invoking signing', async (chain, adapterId, settlementAddress, signingAddress, action) => {
    const resolve = createExecutionAuthorityRegistry(createExecutionAuthorityAdapters(inertOperatorDeps().deps));
    expect(await resolve({ chain, principal: { kind: 'operator' }, action })).toMatchObject({
      kind: 'granted',
      authority: { adapterId, chain, settlementAddress, signingAddress, capabilities: ['venue-managed-submission'] }
    });
    // The returned signing function is deliberately never invoked.
  });

  it.each([
    ['robinhood-chain', 'authority-evm-session-key-unavailable'],
    ['polygon', 'authority-polymarket-delegation-unsupported']
  ] as const)('preserves the missing user %s mechanism reason', async (chain, code) => {
    const resolve = createExecutionAuthorityRegistry(createExecutionAuthorityAdapters(inertOperatorDeps().deps));
    const verdict = await resolve({ ...userRequest, chain });
    expect(verdict).toMatchObject({ kind: 'denied', code });
    if (verdict.kind !== 'denied') throw new Error('unexpected-user-grant');
    expect(verdict.reason).toContain('user:bounded-user');
    expect(verdict.reason).toMatch(/S4-|ADR-0003/);
  });
});
