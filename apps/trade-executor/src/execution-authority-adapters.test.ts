import { describe, expect, it, vi } from 'vitest';
import {
  createExecutionAuthorityAdapters,
  createOperatorPolymarketAuthority,
  createOperatorRobinhoodAuthority,
  createOperatorSolanaAuthority,
  createUserPolymarketAuthority,
  createUserRobinhoodAuthority,
  createUserSolanaAuthority,
  type SolanaTransactionSigner
} from './execution-authority-adapters.js';
import {
  createExecutionAuthorityRegistry,
  type Eip712TypedData,
  type ExecutionAuthorityRequest,
  type ExecutionPrincipal,
  type GrantedExecutionAuthority,
  type VenueActionKind
} from './execution-authority.js';

/**
 * The six adapters (`S4-P7`). No key, no RPC, no wallet client — every dependency
 * is a function, which is the whole reason the port has this shape.
 */

const OPERATOR: ExecutionPrincipal = { kind: 'operator' };
const ALICE: ExecutionPrincipal = { kind: 'user', userId: 'alice' };

function request(
  chain: GrantedExecutionAuthority['chain'],
  principal: ExecutionPrincipal,
  action: VenueActionKind = 'venue-trade'
): ExecutionAuthorityRequest {
  return { chain, principal, action };
}

function fakeSolanaSigner(): SolanaTransactionSigner & {
  signed: string[];
  tips: { tipAccount: string; lamports: number }[];
} {
  const signed: string[] = [];
  const tips: { tipAccount: string; lamports: number }[] = [];
  return {
    publicKey: 'SoLSigner11111111111111111111111111111111111',
    signed,
    tips,
    async sign(transactionBase64) {
      signed.push(transactionBase64);
      return `signed:${transactionBase64}`;
    },
    async buildTip(input) {
      tips.push(input);
      return `tip:${input.tipAccount}:${input.lamports}`;
    }
  };
}

const PERMIT: Eip712TypedData = {
  domain: { name: 'Permit2', chainId: 4663, verifyingContract: '0x000000000022D473030F116dDEE9F6B43aC78BA3' },
  types: {
    PermitSingle: [
      { name: 'details', type: 'PermitDetails' },
      { name: 'spender', type: 'address' },
      { name: 'sigDeadline', type: 'uint256' }
    ]
  },
  primaryType: 'PermitSingle',
  message: { spender: '0xrouter', sigDeadline: '1' }
};

function granted(
  verdict: Awaited<ReturnType<ReturnType<typeof createOperatorSolanaAuthority>['authorize']>>
): GrantedExecutionAuthority {
  if (verdict.kind !== 'granted') {
    throw new Error(`expected a grant, got ${verdict.code}: ${verdict.reason}`);
  }
  return verdict.authority;
}

describe('operator Solana adapter', () => {
  it('settles on the Trojan wallet and reports the Jito signer separately', async () => {
    const signer = fakeSolanaSigner();
    const authority = createOperatorSolanaAuthority({
      trojanWalletAddress: () => 'TrojanWallet1111111111111111111111111111111',
      signer: () => signer
    });

    const grant = granted(await authority.authorize(request('solana', OPERATOR)));

    // Preserved exactly: `copy_executions.target_account` has always held the
    // Trojan wallet on Solana, on both routes. Changing it would orphan every
    // in-flight canonical execution.
    expect(grant.settlementAddress).toBe('TrojanWallet1111111111111111111111111111111');
    expect(grant.signingAddress).toBe(signer.publicKey);
    expect(grant.capabilities).toEqual(['venue-managed-submission', 'sign-chain-transaction']);
    expect(grant.principal).toEqual(OPERATOR);
    expect(grant.expiresAt).toBeNull();
  });

  it('grants with no signing address when only the Trojan route is configured', async () => {
    const authority = createOperatorSolanaAuthority({
      trojanWalletAddress: () => 'TrojanWallet1111111111111111111111111111111',
      signer: () => null
    });

    const grant = granted(await authority.authorize(request('solana', OPERATOR)));

    // The certified default. Authority exists — a third party holds the key —
    // so this must be a grant, not a denial, or live Solana stops working.
    expect(grant.signingAddress).toBeNull();
    expect(grant.capabilities).toEqual(['venue-managed-submission']);
  });

  it('signs a transaction and builds a tip through the injected signer', async () => {
    const signer = fakeSolanaSigner();
    const authority = createOperatorSolanaAuthority({
      trojanWalletAddress: () => 'TrojanWallet1111111111111111111111111111111',
      signer: () => signer
    });
    const grant = granted(await authority.authorize(request('solana', OPERATOR)));

    expect(await grant.sign({ kind: 'solana-transaction', transactionBase64: 'AQID' }))
      .toEqual({ kind: 'signed', encoding: 'base64', value: 'signed:AQID' });
    expect(await grant.sign({ kind: 'solana-tip-transfer', tipAccount: 'tip1', lamports: 42 }))
      .toEqual({ kind: 'signed', encoding: 'base64', value: 'tip:tip1:42' });
    expect(signer.signed).toEqual(['AQID']);
    expect(signer.tips).toEqual([{ tipAccount: 'tip1', lamports: 42 }]);
  });

  it('refuses a signing shape it never advertised', async () => {
    const authority = createOperatorSolanaAuthority({
      trojanWalletAddress: () => 'TrojanWallet1111111111111111111111111111111',
      signer: () => null
    });
    const grant = granted(await authority.authorize(request('solana', OPERATOR)));

    // No `sign-chain-transaction` capability on the Trojan-only route, so being
    // handed transaction bytes is a refusal with a code — not a throw, and
    // certainly not a signature from somewhere else.
    expect(await grant.sign({ kind: 'solana-transaction', transactionBase64: 'AQID' }))
      .toMatchObject({ kind: 'refused', code: 'authority-capability-unsupported' });
    expect(await grant.sign({ kind: 'eip712-typed-data', typedData: PERMIT }))
      .toMatchObject({ kind: 'refused', code: 'authority-capability-unsupported' });
  });

  it('denies when TROJAN_WALLET_ADDRESS is absent', async () => {
    const authority = createOperatorSolanaAuthority({
      trojanWalletAddress: () => null,
      signer: () => fakeSolanaSigner()
    });

    expect(await authority.authorize(request('solana', OPERATOR))).toMatchObject({
      kind: 'denied',
      code: 'authority-operator-not-configured'
    });
  });

  it('reads its dependencies at authorize time, not at construction', async () => {
    // Live readiness is discovered during `main()`: the Jito signer does not
    // exist when the module graph loads. A snapshot taken at construction would
    // report the route unconfigured for the life of the process.
    let signer: SolanaTransactionSigner | null = null;
    const authority = createOperatorSolanaAuthority({
      trojanWalletAddress: () => 'TrojanWallet1111111111111111111111111111111',
      signer: () => signer
    });

    expect(granted(await authority.authorize(request('solana', OPERATOR))).signingAddress)
      .toBeNull();
    signer = fakeSolanaSigner();
    expect(granted(await authority.authorize(request('solana', OPERATOR))).signingAddress)
      .toBe(signer.publicKey);
  });

  it('does not authorize a token spend permission on Solana', async () => {
    const authority = createOperatorSolanaAuthority({
      trojanWalletAddress: () => 'TrojanWallet1111111111111111111111111111111',
      signer: () => fakeSolanaSigner()
    });

    expect(await authority.authorize(request('solana', OPERATOR, 'token-spend-permission')))
      .toMatchObject({ kind: 'denied', code: 'authority-capability-unsupported' });
  });
});

describe('operator Robinhood Chain adapter', () => {
  it('settles and signs on the operator EOA', async () => {
    const authority = createOperatorRobinhoodAuthority({
      accountAddress: () => '0x00000000000000000000000000000000000000aa',
      typedDataSigner: () => async () => '0xsig'
    });

    const grant = granted(await authority.authorize(request('robinhood-chain', OPERATOR)));

    // Same string the per-account nonce serialisation locks on. Two spellings of
    // one account would defeat both `withSubmissionLock` and `EvmNonceLock`.
    expect(grant.settlementAddress).toBe('0x00000000000000000000000000000000000000aa');
    expect(grant.signingAddress).toBe(grant.settlementAddress);
    expect(grant.capabilities).toEqual(['venue-managed-submission', 'sign-typed-data']);
  });

  it('authorizes a Permit2 permit as a typed-data signature (S4-M13)', async () => {
    const signTypedData = vi.fn().mockResolvedValue('0xdeadbeef');
    const authority = createOperatorRobinhoodAuthority({
      accountAddress: () => '0x00000000000000000000000000000000000000aa',
      typedDataSigner: () => signTypedData
    });

    const verdict = await authority.authorize(
      request('robinhood-chain', OPERATOR, 'token-spend-permission')
    );
    const grant = granted(verdict);
    const signed = await grant.sign({ kind: 'eip712-typed-data', typedData: PERMIT });

    // The permit never becomes a transaction: it goes out as a signature through
    // the same port as everything else, which is the seam `S4-P7` provides.
    expect(signed).toEqual({ kind: 'signed', encoding: 'hex', value: '0xdeadbeef' });
    expect(signTypedData).toHaveBeenCalledWith(PERMIT);
  });

  it('denies when EVM_PRIVATE_KEY is absent', async () => {
    const authority = createOperatorRobinhoodAuthority({
      accountAddress: () => null,
      typedDataSigner: () => null
    });

    expect(await authority.authorize(request('robinhood-chain', OPERATOR))).toMatchObject({
      kind: 'denied',
      code: 'authority-operator-not-configured'
    });
  });

  it('turns a thrown signer into a refusal that does not echo the payload', async () => {
    const authority = createOperatorRobinhoodAuthority({
      accountAddress: () => '0x00000000000000000000000000000000000000aa',
      typedDataSigner: () => async () => { throw new Error('hardware wallet locked'); }
    });
    const grant = granted(await authority.authorize(request('robinhood-chain', OPERATOR)));

    const result = await grant.sign({ kind: 'eip712-typed-data', typedData: PERMIT });

    expect(result).toMatchObject({ kind: 'refused', code: 'authority-signing-failed' });
    expect(result.kind === 'refused' && result.reason).toContain('hardware wallet locked');
    expect(result.kind === 'refused' && result.reason).not.toContain('sigDeadline');
  });
});

describe('operator Polymarket adapter', () => {
  it('separates the funder it settles against from the signer it signs with', async () => {
    const authority = createOperatorPolymarketAuthority({
      identity: () => ({
        signerAddress: '0x00000000000000000000000000000000000000aa',
        funderAddress: '0x00000000000000000000000000000000000000bb'
      }),
      typedDataSigner: () => async () => '0xorder'
    });

    const grant = granted(await authority.authorize(request('polygon', OPERATOR)));

    // `target_account` has always held the funder here. The split is real —
    // `signatureType` 1 and 2 separate `signer_address` from `maker_address` —
    // and it is the same split every delegation mechanism would have needed.
    expect(grant.settlementAddress).toBe('0x00000000000000000000000000000000000000bb');
    expect(grant.signingAddress).toBe('0x00000000000000000000000000000000000000aa');
  });

  it('authorizes a redemption, which also submits from the signer', async () => {
    const authority = createOperatorPolymarketAuthority({
      identity: () => ({ signerAddress: '0xaa', funderAddress: '0xbb' }),
      typedDataSigner: () => null
    });

    expect(await authority.authorize(request('polygon', OPERATOR, 'position-redemption')))
      .toMatchObject({ kind: 'granted' });
  });

  it('denies when the Polymarket identity cannot be resolved', async () => {
    const authority = createOperatorPolymarketAuthority({
      identity: () => null,
      typedDataSigner: () => null
    });

    expect(await authority.authorize(request('polygon', OPERATOR))).toMatchObject({
      kind: 'denied',
      code: 'authority-operator-not-configured'
    });
  });
});

describe('per-user adapters fail closed with a named mechanism', () => {
  it.each([
    ['solana', createUserSolanaAuthority(), 'authority-solana-delegate-unavailable'],
    [
      'robinhood-chain',
      createUserRobinhoodAuthority(),
      'authority-evm-session-key-unavailable'
    ],
    ['polygon', createUserPolymarketAuthority(), 'authority-polymarket-delegation-unsupported']
  ] as const)('%s denies with %s', async (chain, authority, code) => {
    const verdict = await authority.authorize(request(chain, ALICE));

    expect(verdict).toMatchObject({ kind: 'denied', code });
    // A generic error would send an operator to read the wrong thing. Each
    // reason names the blocking checklist item or the ADR section that settles it.
    expect(verdict.kind === 'denied' && verdict.reason).toMatch(/S4-|ADR-0003|section/);
    expect(verdict.kind === 'denied' && verdict.reason).toContain('user:alice');
  });

  it('gives the three chains three different codes', async () => {
    // Deliberately distinct: two are scheduling answers with very different
    // schedules, and Polymarket's is architectural. One shared code would send
    // an operator to debug the wrong thing, the mistake `solana-simulation.ts`
    // splits `refuse` from `unavailable` to avoid.
    const codes = new Set<string>();
    for (const adapter of [
      createUserSolanaAuthority(),
      createUserRobinhoodAuthority(),
      createUserPolymarketAuthority()
    ]) {
      const verdict = await adapter.authorize(request(adapter.chain, ALICE));
      if (verdict.kind === 'denied') codes.add(verdict.code);
    }

    expect(codes.size).toBe(3);
  });

  it('never serves the operator, so a missing per-user grant cannot borrow one', async () => {
    for (const adapter of [
      createUserSolanaAuthority(),
      createUserRobinhoodAuthority(),
      createUserPolymarketAuthority()
    ]) {
      expect(adapter.serves(OPERATOR)).toBe(false);
      expect(adapter.serves(ALICE)).toBe(true);
    }
  });
});

describe('the full adapter set', () => {
  const deps = {
    solana: {
      trojanWalletAddress: () => 'TrojanWallet1111111111111111111111111111111',
      signer: () => null
    },
    robinhoodChain: {
      accountAddress: () => '0x00000000000000000000000000000000000000aa',
      typedDataSigner: () => null
    },
    polygon: {
      identity: () => ({ signerAddress: '0xaa', funderAddress: '0xbb' }),
      typedDataSigner: () => null
    }
  };

  it('covers every chain for both principals', async () => {
    const resolve = createExecutionAuthorityRegistry(createExecutionAuthorityAdapters(deps));

    for (const chain of ['solana', 'robinhood-chain', 'polygon'] as const) {
      // Every operator request is granted, and every per-user request is denied
      // with something more specific than "no adapter" — which is what tells an
      // operator the wiring is fine and the mechanism is the thing missing.
      expect(await resolve(request(chain, OPERATOR))).toMatchObject({ kind: 'granted' });
      const forUser = await resolve(request(chain, ALICE));
      expect(forUser.kind).toBe('denied');
      expect(forUser.kind === 'denied' && forUser.code).not.toBe('authority-adapter-missing');
    }
  });

  it('registers the operator adapters in the same list as the per-user ones', () => {
    const adapters = createExecutionAuthorityAdapters(deps);

    // Criterion 4 of `S4-P7`, asserted structurally: six adapters, one interface,
    // no chain served by only one class of principal. If someone lifts the
    // operator path back out into a branch, this count changes.
    expect(adapters).toHaveLength(6);
    for (const chain of ['solana', 'robinhood-chain', 'polygon'] as const) {
      const onChain = adapters.filter((adapter) => adapter.chain === chain);
      expect(onChain.filter((adapter) => adapter.serves(OPERATOR))).toHaveLength(1);
      expect(onChain.filter((adapter) => adapter.serves(ALICE))).toHaveLength(1);
    }
  });
});
