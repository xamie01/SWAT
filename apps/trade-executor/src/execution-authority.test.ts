import { describe, expect, it, vi } from 'vitest';
import {
  capabilityForSigningRequest,
  createExecutionAuthorityRegistry,
  denied,
  describePrincipal,
  type ExecutionAuthorityRequest,
  type ExecutionPrincipal,
  type GrantedExecutionAuthority,
  type UserExecutionAuthority
} from './execution-authority.js';

/**
 * The port itself (`S4-P7`): routing and the guards that sit above every
 * adapter. The adapters are exercised in `execution-authority-adapters.test.ts`;
 * `handleJob`'s use of the port is in `execution-authority-wiring.test.ts`.
 */

const OPERATOR: ExecutionPrincipal = { kind: 'operator' };
const ALICE: ExecutionPrincipal = { kind: 'user', userId: 'alice' };

function grant(input: {
  adapterId: string;
  chain: GrantedExecutionAuthority['chain'];
  principal: ExecutionPrincipal;
  settlementAddress?: string;
}): GrantedExecutionAuthority {
  return {
    adapterId: input.adapterId,
    chain: input.chain,
    principal: input.principal,
    settlementAddress: input.settlementAddress ?? 'settle-1',
    signingAddress: null,
    capabilities: ['venue-managed-submission'],
    expiresAt: null,
    sign: async () => ({
      kind: 'refused',
      code: 'authority-capability-unsupported',
      reason: 'stub'
    })
  };
}

function adapter(input: {
  id: string;
  chain: GrantedExecutionAuthority['chain'];
  serves: (principal: ExecutionPrincipal) => boolean;
  authorize?: UserExecutionAuthority['authorize'];
}): UserExecutionAuthority {
  return {
    id: input.id,
    chain: input.chain,
    serves: input.serves,
    authorize: input.authorize
      ?? (async (request) => ({
        kind: 'granted',
        authority: grant({
          adapterId: input.id,
          chain: input.chain,
          principal: request.principal
        })
      }))
  };
}

const tradeOn = (
  chain: GrantedExecutionAuthority['chain'],
  principal: ExecutionPrincipal
): ExecutionAuthorityRequest => ({ chain, principal, action: 'venue-trade' });

describe('registry routing', () => {
  it('routes to the one adapter that serves the chain and the principal', async () => {
    const operatorSolana = adapter({
      id: 'op-solana',
      chain: 'solana',
      serves: (p) => p.kind === 'operator'
    });
    const userSolana = adapter({
      id: 'user-solana',
      chain: 'solana',
      serves: (p) => p.kind === 'user'
    });
    const resolve = createExecutionAuthorityRegistry([operatorSolana, userSolana]);

    const forOperator = await resolve(tradeOn('solana', OPERATOR));
    const forUser = await resolve(tradeOn('solana', ALICE));

    expect(forOperator.kind === 'granted' && forOperator.authority.adapterId).toBe('op-solana');
    expect(forUser.kind === 'granted' && forUser.authority.adapterId).toBe('user-solana');
  });

  it('picks the operator adapter by the same rule as every other adapter', async () => {
    // The acceptance criterion most likely to be fudged: `operator` must be a
    // registration, not a branch. Registering the per-user adapter FIRST must
    // not change which adapter an operator request reaches — if operator-ness
    // were special-cased anywhere in the routing, ordering would matter.
    const resolveA = createExecutionAuthorityRegistry([
      adapter({ id: 'op', chain: 'polygon', serves: (p) => p.kind === 'operator' }),
      adapter({ id: 'user', chain: 'polygon', serves: (p) => p.kind === 'user' })
    ]);
    const resolveB = createExecutionAuthorityRegistry([
      adapter({ id: 'user', chain: 'polygon', serves: (p) => p.kind === 'user' }),
      adapter({ id: 'op', chain: 'polygon', serves: (p) => p.kind === 'operator' })
    ]);

    for (const resolve of [resolveA, resolveB]) {
      const verdict = await resolve(tradeOn('polygon', OPERATOR));
      expect(verdict.kind === 'granted' && verdict.authority.adapterId).toBe('op');
    }
  });

  it('denies with authority-adapter-missing when no adapter serves the pair', async () => {
    const resolve = createExecutionAuthorityRegistry([
      adapter({ id: 'op-solana', chain: 'solana', serves: (p) => p.kind === 'operator' })
    ]);

    const wrongChain = await resolve(tradeOn('robinhood-chain', OPERATOR));
    const wrongPrincipal = await resolve(tradeOn('solana', ALICE));

    expect(wrongChain).toMatchObject({ kind: 'denied', code: 'authority-adapter-missing' });
    expect(wrongPrincipal).toMatchObject({ kind: 'denied', code: 'authority-adapter-missing' });
  });
});

describe('guards above every adapter', () => {
  it('refuses an adapter that grants for a principal it does not serve', async () => {
    // The failure this port exists to prevent, in its most direct form: an
    // operator adapter answering a user's request. Even if the adapter's own
    // `authorize` says yes, the port must not pass the grant back.
    const overreaching = adapter({
      id: 'op-solana',
      chain: 'solana',
      serves: () => true,
      authorize: async () => ({
        kind: 'granted',
        authority: grant({ adapterId: 'op-solana', chain: 'solana', principal: OPERATOR })
      })
    });
    const resolve = createExecutionAuthorityRegistry([overreaching]);

    const verdict = await resolve(tradeOn('solana', ALICE));

    expect(verdict).toMatchObject({ kind: 'denied', code: 'authority-principal-mismatch' });
  });

  it('refuses a grant issued for a different user than the one requested', async () => {
    const crossed = adapter({
      id: 'user-solana',
      chain: 'solana',
      serves: (p) => p.kind === 'user',
      authorize: async () => ({
        kind: 'granted',
        authority: grant({
          adapterId: 'user-solana',
          chain: 'solana',
          principal: { kind: 'user', userId: 'mallory' }
        })
      })
    });
    const resolve = createExecutionAuthorityRegistry([crossed]);

    const verdict = await resolve(tradeOn('solana', ALICE));

    expect(verdict).toMatchObject({ kind: 'denied', code: 'authority-principal-mismatch' });
  });

  it('refuses a grant stamped with a different chain than the request', async () => {
    const crossed = adapter({
      id: 'op-solana',
      chain: 'solana',
      serves: (p) => p.kind === 'operator',
      authorize: async () => ({
        kind: 'granted',
        authority: grant({ adapterId: 'op-solana', chain: 'polygon', principal: OPERATOR })
      })
    });
    const resolve = createExecutionAuthorityRegistry([crossed]);

    const verdict = await resolve(tradeOn('solana', OPERATOR));

    expect(verdict).toMatchObject({ kind: 'denied', code: 'authority-chain-mismatch' });
  });

  it('never calls an adapter whose chain does not match', async () => {
    const authorize = vi.fn();
    const resolve = createExecutionAuthorityRegistry([
      { id: 'op-solana', chain: 'solana', serves: () => true, authorize }
    ]);

    // `serves` accepts everything, so only the chain guard can stop this.
    const verdict = await resolve(tradeOn('polygon', OPERATOR));

    expect(verdict).toMatchObject({ kind: 'denied' });
    expect(authorize).not.toHaveBeenCalled();
  });

  it('passes a denial through unchanged', async () => {
    const resolve = createExecutionAuthorityRegistry([
      adapter({
        id: 'user-solana',
        chain: 'solana',
        serves: (p) => p.kind === 'user',
        authorize: async () => denied('authority-solana-delegate-unavailable', 'not built')
      })
    ]);

    expect(await resolve(tradeOn('solana', ALICE))).toEqual({
      kind: 'denied',
      code: 'authority-solana-delegate-unavailable',
      reason: 'not built'
    });
  });
});

describe('vocabulary', () => {
  it('maps a signing request to the capability it needs', () => {
    expect(capabilityForSigningRequest({
      kind: 'solana-transaction',
      transactionBase64: 'AA=='
    })).toBe('sign-chain-transaction');
    expect(capabilityForSigningRequest({
      kind: 'solana-tip-transfer',
      tipAccount: 'tip',
      lamports: 1
    })).toBe('sign-chain-transaction');
    // Permit2 (`S4-M13`) rides this one: the permit is a signature, so it needs
    // a capability the port can express rather than a special-cased transaction.
    expect(capabilityForSigningRequest({
      kind: 'eip712-typed-data',
      typedData: { domain: {}, types: {}, primaryType: 'X', message: {} }
    })).toBe('sign-typed-data');
  });

  it('describes principals without leaking anything but the id', () => {
    expect(describePrincipal(OPERATOR)).toBe('operator');
    expect(describePrincipal(ALICE)).toBe('user:alice');
  });
});
