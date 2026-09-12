import { describe, expect, it } from 'vitest';
import { hashDomain, recoverTypedDataAddress, serializeSignature } from 'viem';
import {
  CANONICAL_PERMIT2_ADDRESS,
  MAX_PERMIT2_ALLOWANCE_AMOUNT,
  MAX_UINT48,
  PERMIT2_ALLOWANCE_TRANSFER_TYPES,
  PERMIT2_EIP712_DOMAIN_TYPE,
  assertPermit2DeadlineUnexpired,
  buildPermit2AllowancePlan,
  buildPermit2EnablementCall,
  buildPermit2SignatureTransferPlan,
  describePermit2AllowancePosture,
  isErc20ApproveCall,
  isPermit2NonceUsed,
  nextUnusedPermit2Nonce,
  permit2BitmapPosition,
  permit2Domain,
  permit2DomainSeparator,
  permit2EnablementRequired
} from './permit2.js';

/**
 * `S4-M13` — Permit2 payload construction.
 *
 * The vectors in the first block are **external**. A hash function checked only
 * against its own output is checked against nothing, so the domain separators
 * come from live `DOMAIN_SEPARATOR()` reads on two chains, and the `PermitSingle`
 * case replays a signature Uniswap produced with MetaMask and committed to
 * `test/TypehashGeneration.t.sol`. If any part of the domain, the type strings,
 * the field order or the integer widths were wrong, `ecrecover` would return
 * some other address rather than the documented signer.
 */

const OWNER = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' as const;
const TOKEN = '0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984' as const;
const SPENDER = '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45' as const;

describe('external Permit2 vectors', () => {
  it('reproduces the live Ethereum mainnet Permit2 DOMAIN_SEPARATOR', () => {
    // eth_call DOMAIN_SEPARATOR() -> canonical Permit2, chainId 1,
    // via https://ethereum-rpc.publicnode.com (2026-08-25).
    expect(permit2DomainSeparator({ chainId: 1 })).toBe(
      '0x866a5aba21966af95d6c7ab78eb2b2fc913915c28be3b9aa07cc04ff903e3f28'
    );
  });

  it('reproduces the live Robinhood Chain (4663) Permit2 DOMAIN_SEPARATOR', () => {
    // eth_call DOMAIN_SEPARATOR() -> canonical Permit2 on chain 4663,
    // via https://rpc.mainnet.chain.robinhood.com (2026-08-25). This is the
    // chain S4-M13 targets, and it doubles as proof Permit2 is really deployed
    // there: a bare address with no code cannot answer this call.
    expect(permit2DomainSeparator({ chainId: 4663 })).toBe(
      '0x448684463b1f7965c1ec7c249cee11520df24c07242efc2b20f6e54c85614fad'
    );
  });

  it('omits the version field, unlike almost every other EIP-712 domain', () => {
    expect(permit2Domain({ chainId: 1 })).toEqual({
      name: 'Permit2',
      chainId: 1,
      verifyingContract: CANONICAL_PERMIT2_ADDRESS
    });
    // Guard the specific mistake: adding version:'1' must change the separator,
    // so a future "fix" that adds it cannot pass silently.
    const withVersion = hashDomain({
      domain: { name: 'Permit2', version: '1', chainId: 1, verifyingContract: CANONICAL_PERMIT2_ADDRESS },
      types: {
        EIP712Domain: [
          { name: 'name', type: 'string' },
          { name: 'version', type: 'string' },
          { name: 'chainId', type: 'uint256' },
          { name: 'verifyingContract', type: 'address' }
        ]
      }
    } as never);
    expect(withVersion).not.toBe(permit2DomainSeparator({ chainId: 1 }));
    expect(PERMIT2_EIP712_DOMAIN_TYPE.map((f): string => f.name)).toEqual([
      'name',
      'chainId',
      'verifyingContract'
    ]);
  });

  it("recovers Uniswap's own MetaMask PermitSingle signature to the documented signer", async () => {
    // Constants transcribed from Uniswap/permit2 test/TypehashGeneration.t.sol.
    const plan = buildPermit2AllowancePlan({
      chainId: 1,
      permit2: '0xCe71065D4017F316EC606Fe4422e11eB2c47c246',
      owner: OWNER,
      token: TOKEN,
      spender: SPENDER,
      amount: 100n,
      expiration: 946_902_158_100n,
      sigDeadline: 146_902_158_100n,
      nonce: 0n,
      nowSeconds: 1_700_000_000n
    });
    const signature = serializeSignature({
      r: '0xdb5507adaba8ed8e1d83dc7cb64980735c4769076c657d80563ce9a991fbb198',
      s: '0x1d07973917923c7942307e63285ff2e9e8d435fc4da8cdc7546a669bf474fb6d',
      v: 27n
    });
    await expect(
      recoverTypedDataAddress({ ...plan.typedData, signature } as never)
    ).resolves.toBe(OWNER);
  });

  it("recovers Uniswap's own MetaMask PermitTransferFrom signature to the documented signer", async () => {
    const plan = buildPermit2SignatureTransferPlan({
      chainId: 1,
      permit2: '0xCe71065D4017F316EC606Fe4422e11eB2c47c246',
      owner: OWNER,
      token: TOKEN,
      // The Foundry test hashes under `vm.prank(spender)`, i.e. msg.sender is
      // the spender. That is the address signed into the message.
      spender: SPENDER,
      amount: 100n,
      deadline: 146_902_158_100n,
      nonce: 0n,
      nowSeconds: 1_700_000_000n
    });
    const signature = serializeSignature({
      r: '0xc12d33a96aef9ea42f1ad72587f52b5113b68d7b8fe35675fc0bb1ade3773455',
      s: '0x56f3bbecb0c791bc9e23e58ce3a889f39c4b37b315faa264b8e4b5f2d5f7b365',
      v: 27n
    });
    await expect(
      recoverTypedDataAddress({ ...plan.typedData, signature } as never)
    ).resolves.toBe(OWNER);
  });
});

describe('no approve on the happy path', () => {
  const base = {
    chainId: 4663,
    owner: OWNER,
    token: TOKEN,
    spender: SPENDER,
    amount: 1_000_000n,
    nowSeconds: 1_700_000_000n
  } as const;

  it('emits no calls at all for a router-consumed allowance permit', () => {
    const plan = buildPermit2AllowancePlan({
      ...base,
      expiration: 1_700_003_600n,
      sigDeadline: 1_700_000_120n,
      nonce: 0n
    });
    expect(plan.calls).toEqual([]);
    expect(plan.calls.some(isErc20ApproveCall)).toBe(false);
  });

  it('emits no approve calldata even when driving Permit2 directly', () => {
    const plan = buildPermit2AllowancePlan({
      ...base,
      expiration: 1_700_003_600n,
      sigDeadline: 1_700_000_120n,
      nonce: 3n,
      emitPermitCall: true,
      signature: `0x${'11'.repeat(65)}`
    });
    expect(plan.calls).toHaveLength(1);
    expect(plan.calls[0]?.purpose).toBe('permit2-permit');
    expect(plan.calls.some(isErc20ApproveCall)).toBe(false);
    // The one call must target Permit2, never the token.
    expect(plan.calls[0]?.to).toBe(CANONICAL_PERMIT2_ADDRESS);
  });

  it('emits no approve calldata for a signature-transfer pull', () => {
    const plan = buildPermit2SignatureTransferPlan({
      ...base,
      deadline: 1_700_000_120n,
      nonce: 5n,
      emitTransferCall: true,
      signature: `0x${'22'.repeat(65)}`
    });
    expect(plan.calls.some(isErc20ApproveCall)).toBe(false);
    expect(plan.calls[0]?.purpose).toBe('permit2-transfer-from');
  });

  it('confines approve calldata to the one-time enablement call', () => {
    const call = buildPermit2EnablementCall({ token: TOKEN, amount: 1_000_000n });
    // Proves the detector actually detects, so the assertions above are not
    // vacuously true against a predicate that never fires.
    expect(isErc20ApproveCall(call)).toBe(true);
    expect(call.to).toBe(TOKEN);
    expect(call.purpose).toBe('permit2-enablement-approve');
  });

  it('reports enablement as required only while the allowance is short', () => {
    expect(permit2EnablementRequired({ currentAllowanceToPermit2: 0n, amount: 1n })).toBe(true);
    expect(permit2EnablementRequired({ currentAllowanceToPermit2: 5n, amount: 5n })).toBe(false);
    expect(permit2EnablementRequired({ currentAllowanceToPermit2: 6n, amount: 5n })).toBe(false);
  });
});

describe('deadline handling', () => {
  const base = {
    chainId: 4663,
    owner: OWNER,
    token: TOKEN,
    spender: SPENDER,
    amount: 1n,
    expiration: 1_700_003_600n,
    nonce: 0n
  } as const;

  it('accepts a deadline exactly equal to now, matching block.timestamp > sigDeadline', () => {
    expect(() =>
      assertPermit2DeadlineUnexpired({ sigDeadline: 1_700_000_000n, nowSeconds: 1_700_000_000n })
    ).not.toThrow();
  });

  it('rejects a deadline one second in the past', () => {
    expect(() =>
      assertPermit2DeadlineUnexpired({ sigDeadline: 1_699_999_999n, nowSeconds: 1_700_000_000n })
    ).toThrow(/already expired/);
  });

  it('refuses to build an allowance plan with an expired signature deadline', () => {
    expect(() =>
      buildPermit2AllowancePlan({ ...base, sigDeadline: 1_699_999_000n, nowSeconds: 1_700_000_000n })
    ).toThrow(/already expired/);
  });

  it('refuses to build a signature-transfer plan with an expired deadline', () => {
    expect(() =>
      buildPermit2SignatureTransferPlan({
        chainId: 4663,
        owner: OWNER,
        token: TOKEN,
        spender: SPENDER,
        amount: 1n,
        deadline: 1_699_999_000n,
        nonce: 0n,
        nowSeconds: 1_700_000_000n
      })
    ).toThrow(/already expired/);
  });

  it('rejects expiration 0 unless block-scoped expiry is opted into', () => {
    // Permit2 stores `expiration == 0 ? uint48(block.timestamp)`, so zero means
    // one block, not "forever" — the opposite of the intuitive reading.
    expect(() =>
      buildPermit2AllowancePlan({
        ...base,
        expiration: 0n,
        sigDeadline: 1_700_000_120n,
        nowSeconds: 1_700_000_000n
      })
    ).toThrow(/single block/);
    expect(() =>
      buildPermit2AllowancePlan({
        ...base,
        expiration: 0n,
        sigDeadline: 1_700_000_120n,
        nowSeconds: 1_700_000_000n,
        allowBlockScopedExpiration: true
      })
    ).not.toThrow();
  });

  it('rejects an allowance expiration already in the past', () => {
    expect(() =>
      buildPermit2AllowancePlan({
        ...base,
        expiration: 1_699_000_000n,
        sigDeadline: 1_700_000_120n,
        nowSeconds: 1_700_000_000n
      })
    ).toThrow(/already past/);
  });

  it('carries the deadline into the policy subject rather than burying it', () => {
    const plan = buildPermit2AllowancePlan({
      ...base,
      sigDeadline: 1_700_000_120n,
      nowSeconds: 1_700_000_000n
    });
    expect(plan.subject.sigDeadline).toBe(1_700_000_120n);
    expect(plan.subject.expiration).toBe(1_700_003_600n);
  });
});

describe('nonce semantics', () => {
  it('splits an unordered nonce into wordPos and bitPos like bitmapPositions', () => {
    expect(permit2BitmapPosition(0n)).toEqual({ wordPos: 0n, bitPos: 0 });
    expect(permit2BitmapPosition(255n)).toEqual({ wordPos: 0n, bitPos: 255 });
    expect(permit2BitmapPosition(256n)).toEqual({ wordPos: 1n, bitPos: 0 });
    expect(permit2BitmapPosition(513n)).toEqual({ wordPos: 2n, bitPos: 1 });
  });

  it('reads a spent bit as used', () => {
    expect(isPermit2NonceUsed({ nonce: 3n, bitmapWord: 0b1000n })).toBe(true);
    expect(isPermit2NonceUsed({ nonce: 2n, bitmapWord: 0b1000n })).toBe(false);
    // Bit position is taken modulo the word, so a nonce in another word must not
    // be answered from this word's bits by accident.
    expect(isPermit2NonceUsed({ nonce: 259n, bitmapWord: 0b1000n })).toBe(true);
  });

  it('never returns a nonce that is already spent', () => {
    expect(nextUnusedPermit2Nonce({ wordPos: 0n, bitmapWord: 0n })).toBe(0n);
    expect(nextUnusedPermit2Nonce({ wordPos: 0n, bitmapWord: 0b0001n })).toBe(1n);
    expect(nextUnusedPermit2Nonce({ wordPos: 0n, bitmapWord: 0b0111n })).toBe(3n);
    expect(nextUnusedPermit2Nonce({ wordPos: 4n, bitmapWord: 0b0011n })).toBe(1026n);
  });

  it('returns null when all 256 bits in the word are spent', () => {
    expect(nextUnusedPermit2Nonce({ wordPos: 0n, bitmapWord: (1n << 256n) - 1n })).toBe(null);
  });

  it('selects distinct nonces for concurrent permits once each is marked spent', () => {
    // The footgun this guards: two permits chosen from the *same* observed
    // bitmap both pick the lowest clear bit and collide, and the second reverts
    // InvalidNonce. Selection must consume as it goes.
    let word = 0b0001n;
    const chosen: bigint[] = [];
    for (let i = 0; i < 4; i += 1) {
      const next = nextUnusedPermit2Nonce({ wordPos: 0n, bitmapWord: word });
      expect(next).not.toBe(null);
      chosen.push(next as bigint);
      word |= 1n << BigInt(permit2BitmapPosition(next as bigint).bitPos);
    }
    expect(chosen).toEqual([1n, 2n, 3n, 4n]);
    expect(new Set(chosen).size).toBe(chosen.length);
    for (const nonce of chosen) {
      expect(isPermit2NonceUsed({ nonce, bitmapWord: word })).toBe(true);
    }
  });

  it('labels the two nonce spaces distinctly so they cannot be conflated', () => {
    const allowance = buildPermit2AllowancePlan({
      chainId: 4663,
      owner: OWNER,
      token: TOKEN,
      spender: SPENDER,
      amount: 1n,
      expiration: 1_700_003_600n,
      sigDeadline: 1_700_000_120n,
      nonce: 7n,
      nowSeconds: 1_700_000_000n
    });
    const transfer = buildPermit2SignatureTransferPlan({
      chainId: 4663,
      owner: OWNER,
      token: TOKEN,
      spender: SPENDER,
      amount: 1n,
      deadline: 1_700_000_120n,
      nonce: 7n,
      nowSeconds: 1_700_000_000n
    });
    // Same numeric nonce, different mechanism. AllowanceTransfer compares for
    // equality against a stored counter; SignatureTransfer flips a bitmap bit.
    expect(allowance.subject.nonceSpace).toBe('sequential-uint48');
    expect(transfer.subject.nonceSpace).toBe('unordered-bitmap-uint256');
    expect(allowance.subject.nonce).toBe(transfer.subject.nonce);
    expect(allowance.digest).not.toBe(transfer.digest);
  });

  it('rejects a sequential nonce wider than uint48', () => {
    expect(() =>
      buildPermit2AllowancePlan({
        chainId: 4663,
        owner: OWNER,
        token: TOKEN,
        spender: SPENDER,
        amount: 1n,
        expiration: 1_700_003_600n,
        sigDeadline: 1_700_000_120n,
        nonce: MAX_UINT48 + 1n,
        nowSeconds: 1_700_000_000n
      })
    ).toThrow(/exceeds its on-chain width/);
  });

  it('changes the digest when only the nonce changes', () => {
    const build = (nonce: bigint) =>
      buildPermit2AllowancePlan({
        chainId: 4663,
        owner: OWNER,
        token: TOKEN,
        spender: SPENDER,
        amount: 1n,
        expiration: 1_700_003_600n,
        sigDeadline: 1_700_000_120n,
        nonce,
        nowSeconds: 1_700_000_000n
      }).digest;
    expect(build(0n)).not.toBe(build(1n));
  });
});

describe('policy-inspectable subject (S4-P10)', () => {
  it('exposes token, spender, amount and deadline as flat fields', () => {
    const plan = buildPermit2AllowancePlan({
      chainId: 4663,
      owner: OWNER,
      token: TOKEN,
      spender: SPENDER,
      amount: 4_200n,
      expiration: 1_700_003_600n,
      sigDeadline: 1_700_000_120n,
      nonce: 0n,
      nowSeconds: 1_700_000_000n
    });
    expect(plan.subject).toMatchObject({
      kind: 'allowance-transfer',
      chainId: 4663,
      permit2: CANONICAL_PERMIT2_ADDRESS,
      owner: OWNER,
      token: TOKEN,
      spender: SPENDER,
      amount: 4_200n,
      sigDeadline: 1_700_000_120n
    });
  });

  it('surfaces the spender for signature-transfer even though the struct omits it', () => {
    const plan = buildPermit2SignatureTransferPlan({
      chainId: 4663,
      owner: OWNER,
      token: TOKEN,
      spender: SPENDER,
      amount: 9n,
      deadline: 1_700_000_120n,
      nonce: 0n,
      nowSeconds: 1_700_000_000n
    });
    // Not in the ABI struct (Permit2 substitutes msg.sender) but signed over, so
    // a policy engine must still be able to constrain it.
    expect(plan.subject.spender).toBe(SPENDER);
    expect(plan.subject.expiration).toBe(null);
  });

  it('checksums addresses so policy comparisons cannot miss on case', () => {
    const plan = buildPermit2AllowancePlan({
      chainId: 4663,
      owner: OWNER.toLowerCase() as `0x${string}`,
      token: TOKEN.toLowerCase() as `0x${string}`,
      spender: SPENDER.toLowerCase() as `0x${string}`,
      amount: 1n,
      expiration: 1_700_003_600n,
      sigDeadline: 1_700_000_120n,
      nonce: 0n,
      nowSeconds: 1_700_000_000n
    });
    expect(plan.subject.token).toBe(TOKEN);
    expect(plan.subject.spender).toBe(SPENDER);
  });

  it('never accepts a signing key', () => {
    // S4-P7: the permit is a signature that flows through UserExecutionAuthority.
    const source = buildPermit2AllowancePlan.toString();
    expect(source).not.toMatch(/privateKey|signTypedData|mnemonic/i);
  });
});

describe('width and argument guards', () => {
  const base = {
    chainId: 4663,
    owner: OWNER,
    token: TOKEN,
    spender: SPENDER,
    expiration: 1_700_003_600n,
    sigDeadline: 1_700_000_120n,
    nonce: 0n,
    nowSeconds: 1_700_000_000n
  } as const;

  it('rejects an allowance amount wider than uint160', () => {
    expect(() =>
      buildPermit2AllowancePlan({ ...base, amount: MAX_PERMIT2_ALLOWANCE_AMOUNT + 1n })
    ).toThrow(/exceeds its on-chain width/);
    expect(() =>
      buildPermit2AllowancePlan({ ...base, amount: MAX_PERMIT2_ALLOWANCE_AMOUNT })
    ).not.toThrow();
  });

  it('rejects a negative amount', () => {
    expect(() => buildPermit2AllowancePlan({ ...base, amount: -1n })).toThrow(/non-negative/);
  });

  it('rejects a requestedAmount above the permitted ceiling', () => {
    expect(() =>
      buildPermit2SignatureTransferPlan({
        chainId: 4663,
        owner: OWNER,
        token: TOKEN,
        spender: SPENDER,
        amount: 10n,
        requestedAmount: 11n,
        deadline: 1_700_000_120n,
        nonce: 0n,
        nowSeconds: 1_700_000_000n
      })
    ).toThrow(/exceeds permitted/);
  });

  it('rejects a non-positive chainId', () => {
    expect(() => permit2Domain({ chainId: 0 })).toThrow(/positive integer chainId/);
  });

  it('requires a signature before it will encode a call', () => {
    expect(() =>
      buildPermit2AllowancePlan({ ...base, amount: 1n, emitPermitCall: true })
    ).toThrow(/requires the signature/);
  });

  it('rejects a zero enablement amount', () => {
    expect(() => buildPermit2EnablementCall({ token: TOKEN, amount: 0n })).toThrow(/must be positive/);
  });

  it('keeps the declared EIP-712 widths pinned to the on-chain struct', () => {
    // These widths are load-bearing: widening amount to uint256 silently changes
    // every struct hash, and the only symptom is InvalidSigner.
    expect(PERMIT2_ALLOWANCE_TRANSFER_TYPES.PermitDetails).toEqual([
      { name: 'token', type: 'address' },
      { name: 'amount', type: 'uint160' },
      { name: 'expiration', type: 'uint48' },
      { name: 'nonce', type: 'uint48' }
    ]);
  });
});

describe('composes with the authority port (S4-P7)', () => {
  /**
   * A local mirror of `execution-authority.ts`'s `Eip712TypedData`.
   *
   * Mirrored rather than imported because that port is being refactored
   * concurrently, and a type-only import would make this suite fail for reasons
   * that have nothing to do with Permit2. The trade-off is that this copy can go
   * stale — so it is written to the same shape deliberately, and the master agent
   * should replace it with the real import once `S4-P7` settles.
   *
   * The check is real: viem's own `TypedDataDefinition` does **not** satisfy this
   * (it makes `domain` optional and allows `chainId: bigint`), which is why
   * `Permit2TypedData` exists.
   */
  type PortEip712TypedData = {
    readonly domain: {
      readonly name?: string;
      readonly version?: string;
      readonly chainId?: number;
      readonly verifyingContract?: string;
      readonly salt?: string;
    };
    readonly types: Readonly<
      Record<string, readonly { readonly name: string; readonly type: string }[]>
    >;
    readonly primaryType: string;
    readonly message: Readonly<Record<string, unknown>>;
  };

  it('hands the authority port a payload it can sign as-is', () => {
    const plan = buildPermit2AllowancePlan({
      chainId: 4663,
      owner: OWNER,
      token: TOKEN,
      spender: SPENDER,
      amount: 1n,
      expiration: 1_700_003_600n,
      sigDeadline: 1_700_000_120n,
      nonce: 0n,
      nowSeconds: 1_700_000_000n
    });
    // Compile-time: no cast. If Permit2TypedData ever widens, this stops building.
    const payload: PortEip712TypedData = plan.typedData;
    const request: { kind: 'eip712-typed-data'; typedData: PortEip712TypedData } = {
      kind: 'eip712-typed-data',
      typedData: plan.typedData
    };
    expect(payload.primaryType).toBe('PermitSingle');
    expect(payload.domain.chainId).toBe(4663);
    expect(request.kind).toBe('eip712-typed-data');
  });

  it('hands the port a signature-transfer payload too', () => {
    const plan = buildPermit2SignatureTransferPlan({
      chainId: 4663,
      owner: OWNER,
      token: TOKEN,
      spender: SPENDER,
      amount: 1n,
      deadline: 1_700_000_120n,
      nonce: 0n,
      nowSeconds: 1_700_000_000n
    });
    const payload: PortEip712TypedData = plan.typedData;
    expect(payload.primaryType).toBe('PermitTransferFrom');
  });
});

describe('residual allowance posture', () => {
  it('documents that the allowance moves to Permit2 rather than disappearing', () => {
    const posture = describePermit2AllowancePosture();
    expect(posture.standingAllowanceToRouter).toBe('none');
    expect(posture.approvalsPerTrade).toBe(0);
    expect(posture.approvalsPerTokenLifetime).toBe(1);
    expect(posture.notes.join(' ')).toMatch(/moves/);
  });
});
