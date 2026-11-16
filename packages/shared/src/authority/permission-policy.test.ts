import { describe, it, expect } from 'vitest';
import {
  ACCOUNT_EXECUTE,
  ERC20_APPROVE,
  ERC20_TRANSFER,
  type EvmFunctionDescriptor
} from './evm-calldata.js';
import {
  AuthorityPolicyError,
  MAX_UINT160,
  MAX_UINT256,
  ROBINHOOD_CHAIN_ID,
  authorizeUserOperationCall,
  compileAuthorityPolicy,
  evaluateAuthorityAction,
  isPermitted,
  type AuthorityContractCall,
  type AuthorityEvaluationContext,
  type AuthoritySignedStruct
} from './permission-policy.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TOKEN = '0x1111111111111111111111111111111111111111';
const ROUTER = '0x2222222222222222222222222222222222222222';
const ATTACKER = '0x3333333333333333333333333333333333333333';
const OWNER = '0x4444444444444444444444444444444444444444';
const ACCOUNT = '0x5555555555555555555555555555555555555555';
const PERMIT2 = '0x6666666666666666666666666666666666666666';

const SWAP_SELECTOR = ERC20_TRANSFER.selector;
const APPROVE_CAP = 1_000_000n;

const DESCRIPTORS: readonly EvmFunctionDescriptor[] = [
  ERC20_APPROVE,
  ERC20_TRANSFER,
  ACCOUNT_EXECUTE
];

const NOW = 1_800_000_000;

const CONTEXT: AuthorityEvaluationContext = {
  ownerAccount: OWNER,
  nowSeconds: NOW,
  grantExpiresAtSeconds: NOW + 3600
};

function addressWord(address: string): string {
  return address.replace(/^0x/, '').toLowerCase().padStart(64, '0');
}

function uintWord(value: bigint): string {
  return value.toString(16).padStart(64, '0');
}

function encodeApprove(spender: string, amount: bigint): string {
  return `${ERC20_APPROVE.selector}${addressWord(spender)}${uintWord(amount)}`;
}

function encodeExecute(dest: string, value: bigint, inner: string): string {
  const body = inner.replace(/^0x/, '');
  const byteLength = body.length / 2;
  const padded = body.padEnd(Math.ceil(byteLength / 32) * 64, '0');
  return `${ACCOUNT_EXECUTE.selector}${addressWord(dest)}${uintWord(value)}${uintWord(96n)}${uintWord(
    BigInt(byteLength)
  )}${padded}`;
}

/** The approve rule §2.1 demands: allowlisted spender, bounded amount. */
const APPROVE_RULE = {
  id: 'approve-router',
  effect: 'allow',
  scope: {
    kind: 'contract-call',
    targets: [TOKEN],
    selector: ERC20_APPROVE.selector,
    functionName: 'approve'
  },
  conditions: [
    { field: 'approve.spender', op: 'address_in', addresses: [ROUTER] },
    { field: 'approve.amount', op: 'uint_lte', max: APPROVE_CAP.toString() }
  ]
};

/** The swap rule §2.1 demands: recipient pinned to the user's own account. */
const SWAP_RULE = {
  id: 'swap-on-router',
  effect: 'allow',
  scope: {
    kind: 'contract-call',
    targets: [ROUTER],
    selector: SWAP_SELECTOR,
    functionName: 'transfer'
  },
  conditions: [
    { field: 'transfer.recipient', op: 'address_is_owner' },
    { field: 'transfer.amountIn', op: 'uint_lte', max: APPROVE_CAP.toString() }
  ]
};

function policy(rules: unknown[] = [APPROVE_RULE, SWAP_RULE]) {
  return compileAuthorityPolicy({ version: 1, chainId: ROBINHOOD_CHAIN_ID, rules });
}

function swapAction(overrides: Partial<AuthorityContractCall> = {}): AuthorityContractCall {
  return {
    kind: 'contract-call',
    chainId: ROBINHOOD_CHAIN_ID,
    target: ROUTER,
    selector: SWAP_SELECTOR,
    functionName: 'transfer',
    value: 0n,
    args: { recipient: OWNER, amountIn: 500n },
    ...overrides
  };
}

// ---------------------------------------------------------------------------
// The permitted path
// ---------------------------------------------------------------------------

describe('S4-P10 — argument-scoped permission policy: the permitted path', () => {
  it('permits an approve to an allowlisted router within the bound', () => {
    const verdict = authorizeUserOperationCall(
      policy(),
      {
        chainId: ROBINHOOD_CHAIN_ID,
        sender: ACCOUNT,
        callData: encodeExecute(TOKEN, 0n, encodeApprove(ROUTER, 250_000n))
      },
      DESCRIPTORS,
      CONTEXT
    );
    expect(verdict).toMatchObject({ kind: 'permit', ruleId: 'approve-router', matched: 'approve' });
    expect(isPermitted(verdict)).toBe(true);
  });

  it('permits a swap whose recipient is the owner account', () => {
    expect(evaluateAuthorityAction(policy(), swapAction(), CONTEXT)).toMatchObject({
      kind: 'permit',
      ruleId: 'swap-on-router'
    });
  });

  it('compares EVM addresses case-insensitively on both sides', () => {
    const mixedCasePolicy = compileAuthorityPolicy({
      chainId: ROBINHOOD_CHAIN_ID,
      rules: [
        {
          ...APPROVE_RULE,
          scope: { ...APPROVE_RULE.scope, targets: [TOKEN.toUpperCase().replace('0X', '0x')] },
          conditions: [
            {
              field: 'approve.spender',
              op: 'address_in',
              addresses: [ROUTER.toUpperCase().replace('0X', '0x')]
            },
            { field: 'approve.amount', op: 'uint_lte', max: '1000000' }
          ]
        }
      ]
    });
    const verdict = evaluateAuthorityAction(
      mixedCasePolicy,
      {
        kind: 'contract-call',
        chainId: ROBINHOOD_CHAIN_ID,
        target: TOKEN.toUpperCase().replace('0X', '0x'),
        selector: ERC20_APPROVE.selector,
        functionName: 'approve',
        value: 0n,
        args: { spender: ROUTER.toUpperCase().replace('0X', '0x'), amount: 1n }
      },
      CONTEXT
    );
    expect(verdict.kind).toBe('permit');
  });

  it('accepts a chain-prefixed owner account, because the grant column may be read prefixed', () => {
    const verdict = evaluateAuthorityAction(policy(), swapAction(), {
      ...CONTEXT,
      ownerAccount: `robinhood-chain:${OWNER}`
    });
    expect(verdict.kind).toBe('permit');
  });
});

// ---------------------------------------------------------------------------
// The acceptance criterion
// ---------------------------------------------------------------------------

describe('S4-P10 — the approve hole (ADR-0003 §2.1)', () => {
  it('rejects a UserOperation approving a non-allowlisted spender', () => {
    // The whole point of the item: this UserOperation calls only `approve`, on a
    // token the scope permits, with the selector the scope permits, for a modest
    // amount. A (target, selector) policy admits it. It hands an attacker the
    // token.
    const verdict = authorizeUserOperationCall(
      policy(),
      {
        chainId: ROBINHOOD_CHAIN_ID,
        sender: ACCOUNT,
        callData: encodeExecute(TOKEN, 0n, encodeApprove(ATTACKER, 1n))
      },
      DESCRIPTORS,
      CONTEXT
    );
    expect(verdict.kind).toBe('deny');
    expect(verdict).toMatchObject({
      kind: 'deny',
      code: 'authority-deny-condition-failed',
      ruleId: 'approve-router',
      field: 'approve.spender'
    });
    expect(isPermitted(verdict)).toBe(false);
  });

  it('rejects an approve of type(uint256).max even to an allowlisted router', () => {
    const verdict = authorizeUserOperationCall(
      policy(),
      {
        chainId: ROBINHOOD_CHAIN_ID,
        sender: ACCOUNT,
        callData: encodeExecute(TOKEN, 0n, encodeApprove(ROUTER, MAX_UINT256))
      },
      DESCRIPTORS,
      CONTEXT
    );
    expect(verdict).toMatchObject({
      kind: 'deny',
      code: 'authority-deny-condition-failed',
      field: 'approve.amount'
    });
  });

  it('refuses at construction a policy whose amount bound is itself type(uint256).max', () => {
    expect(() =>
      policy([
        {
          ...APPROVE_RULE,
          conditions: [
            { field: 'approve.spender', op: 'address_in', addresses: [ROUTER] },
            { field: 'approve.amount', op: 'uint_lte', max: MAX_UINT256 }
          ]
        }
      ])
    ).toThrow(
      expect.objectContaining({ code: 'authority-policy-invalid-unbounded-amount' })
    );
  });

  it('refuses at construction an amount bound of type(uint160).max, Permit2 unlimited', () => {
    expect(() =>
      policy([
        {
          ...APPROVE_RULE,
          conditions: [
            { field: 'approve.spender', op: 'address_in', addresses: [ROUTER] },
            { field: 'approve.amount', op: 'uint_lte', max: MAX_UINT160 }
          ]
        }
      ])
    ).toThrow(
      expect.objectContaining({ code: 'authority-policy-invalid-unbounded-amount' })
    );
  });

  it('refuses at construction an approve rule with no spender constraint', () => {
    expect(() =>
      policy([
        {
          ...APPROVE_RULE,
          conditions: [{ field: 'approve.amount', op: 'uint_lte', max: '1000' }]
        }
      ])
    ).toThrow(
      expect.objectContaining({ code: 'authority-policy-invalid-unbounded-approval' })
    );
  });

  it('refuses at construction an approve rule with no amount bound', () => {
    expect(() =>
      policy([
        {
          ...APPROVE_RULE,
          conditions: [{ field: 'approve.spender', op: 'address_in', addresses: [ROUTER] }]
        }
      ])
    ).toThrow(
      expect.objectContaining({ code: 'authority-policy-invalid-unbounded-approval' })
    );
  });

  it('refuses at construction a setApprovalForAll rule with no operator constraint', () => {
    expect(() =>
      policy([
        {
          id: 'approve-all',
          effect: 'allow',
          scope: {
            kind: 'contract-call',
            targets: [TOKEN],
            selector: '0xa22cb465',
            functionName: 'setApprovalForAll'
          },
          conditions: [{ field: 'setApprovalForAll.approved', op: 'bool_eq', value: true }]
        }
      ])
    ).toThrow(
      expect.objectContaining({ code: 'authority-policy-invalid-unbounded-approval' })
    );
  });
});

// ---------------------------------------------------------------------------
// Default-deny
// ---------------------------------------------------------------------------

describe('S4-P10 — default-deny is structural', () => {
  it('denies an unlisted target', () => {
    const verdict = evaluateAuthorityAction(
      policy(),
      swapAction({ target: ATTACKER }),
      CONTEXT
    );
    expect(verdict).toMatchObject({ kind: 'deny', code: 'authority-deny-no-matching-rule' });
  });

  it('denies an unlisted selector on an allowlisted target', () => {
    const verdict = evaluateAuthorityAction(
      policy(),
      swapAction({ selector: '0xdeadbeef', functionName: 'sweep' }),
      CONTEXT
    );
    expect(verdict).toMatchObject({ kind: 'deny', code: 'authority-deny-no-matching-rule' });
  });

  it('denies a transfer even though the token is an allowlisted approve target', () => {
    const verdict = authorizeUserOperationCall(
      policy(),
      {
        chainId: ROBINHOOD_CHAIN_ID,
        sender: ACCOUNT,
        callData: encodeExecute(
          TOKEN,
          0n,
          `${ERC20_TRANSFER.selector}${addressWord(ATTACKER)}${uintWord(1n)}`
        )
      },
      DESCRIPTORS,
      CONTEXT
    );
    expect(verdict).toMatchObject({ kind: 'deny', code: 'authority-deny-no-matching-rule' });
  });

  it('denies a nested execute by falling through to default-deny, with no special case', () => {
    const verdict = authorizeUserOperationCall(
      policy(),
      {
        chainId: ROBINHOOD_CHAIN_ID,
        sender: ACCOUNT,
        callData: encodeExecute(ACCOUNT, 0n, encodeExecute(TOKEN, 0n, encodeApprove(ATTACKER, 1n)))
      },
      DESCRIPTORS,
      CONTEXT
    );
    expect(verdict).toMatchObject({ kind: 'deny', code: 'authority-deny-no-matching-rule' });
  });

  it('denies an empty policy everything', () => {
    expect(evaluateAuthorityAction(policy([]), swapAction(), CONTEXT)).toMatchObject({
      kind: 'deny',
      code: 'authority-deny-no-matching-rule'
    });
  });

  it('denies attached native value when the matched rule says nothing about value', () => {
    const verdict = evaluateAuthorityAction(policy(), swapAction({ value: 1n }), CONTEXT);
    expect(verdict).toMatchObject({
      kind: 'deny',
      code: 'authority-deny-value-not-permitted',
      field: 'call.value'
    });
  });

  it('denies a swap whose recipient is not the owner account', () => {
    const verdict = evaluateAuthorityAction(
      policy(),
      swapAction({ args: { recipient: ATTACKER, amountIn: 1n } }),
      CONTEXT
    );
    expect(verdict).toMatchObject({
      kind: 'deny',
      code: 'authority-deny-condition-failed',
      ruleId: 'swap-on-router',
      field: 'transfer.recipient'
    });
  });

  it('denies a chain mismatch even when every argument would have passed', () => {
    const verdict = evaluateAuthorityAction(policy(), swapAction({ chainId: 137 }), CONTEXT);
    expect(verdict).toMatchObject({ kind: 'deny', code: 'authority-deny-chain-mismatch' });
  });

  it('denies once the grant has expired', () => {
    const verdict = evaluateAuthorityAction(policy(), swapAction(), {
      ...CONTEXT,
      grantExpiresAtSeconds: NOW - 1
    });
    expect(verdict).toMatchObject({ kind: 'deny', code: 'authority-deny-grant-expired' });
  });

  it('rejects a deny-effect rule, because there is no blocklist to add to', () => {
    expect(() => policy([{ ...SWAP_RULE, effect: 'deny' }])).toThrow(
      expect.objectContaining({ code: 'authority-policy-invalid-document' })
    );
  });

  it('rejects an unscoped rule rather than reading it as "any target"', () => {
    expect(() => policy([{ ...SWAP_RULE, scope: { ...SWAP_RULE.scope, targets: [] } }])).toThrow(
      expect.objectContaining({ code: 'authority-policy-invalid-unscoped-rule' })
    );
  });
});

// ---------------------------------------------------------------------------
// Footgun 1 — overlapping ALLOW rules
// ---------------------------------------------------------------------------

describe('S4-P10 — footgun 1: overlapping ALLOW rules let the looser one win (DG-3)', () => {
  it('rejects overlapping ALLOW rules on the same (target, selector) at construction time', () => {
    // Without this, the second rule's wider allowlist unions with the first's and
    // the tight rule is silently defeated — the exact DG-3 finding.
    const loose = {
      id: 'approve-anything',
      effect: 'allow',
      scope: {
        kind: 'contract-call',
        targets: [TOKEN],
        selector: ERC20_APPROVE.selector,
        functionName: 'approve'
      },
      conditions: [
        { field: 'approve.spender', op: 'address_in', addresses: [ROUTER, ATTACKER] },
        { field: 'approve.amount', op: 'uint_lte', max: '999999999' }
      ]
    };

    let thrown: unknown;
    try {
      policy([APPROVE_RULE, loose]);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AuthorityPolicyError);
    expect(thrown).toMatchObject({ code: 'authority-policy-invalid-overlapping-allow' });
    expect((thrown as Error).message).toContain('approve-router');
    expect((thrown as Error).message).toContain('approve-anything');
  });

  it('rejects overlapping signed-struct ALLOW rules on the same (verifyingContract, primaryType)', () => {
    const permitRule = (id: string, spender: string) => ({
      id,
      effect: 'allow',
      scope: { kind: 'signed-struct', verifyingContracts: [PERMIT2], primaryType: 'PermitSingle' },
      conditions: [
        { field: 'message.spender', op: 'address_in', addresses: [spender] },
        { field: 'message.details.amount', op: 'uint_lte', max: '1000' }
      ]
    });
    expect(() => policy([permitRule('tight', ROUTER), permitRule('loose', ATTACKER)])).toThrow(
      expect.objectContaining({ code: 'authority-policy-invalid-overlapping-allow' })
    );
  });

  it('permits non-overlapping rules that differ only by target', () => {
    const otherToken = '0x7777777777777777777777777777777777777777';
    const compiled = policy([
      APPROVE_RULE,
      {
        ...APPROVE_RULE,
        id: 'approve-router-other-token',
        scope: { ...APPROVE_RULE.scope, targets: [otherToken] }
      }
    ]);
    expect(compiled.rules).toHaveLength(2);
  });

  it('rejects duplicate rule ids, because verdict codes name the rule', () => {
    expect(() =>
      policy([
        APPROVE_RULE,
        { ...SWAP_RULE, id: 'approve-router' }
      ])
    ).toThrow(expect.objectContaining({ code: 'authority-policy-invalid-duplicate-rule-id' }));
  });

  it('reports a hand-built ambiguous policy as unresolved rather than picking a rule', () => {
    // compileAuthorityPolicy cannot produce this. A caller constructing a
    // CompiledAuthorityPolicy by hand can, and must not get union semantics.
    const compiled = policy([SWAP_RULE]);
    const handBuilt = {
      ...compiled,
      rules: [compiled.rules[0]!, { ...compiled.rules[0]!, id: 'shadow' }]
    };
    expect(evaluateAuthorityAction(handBuilt, swapAction(), CONTEXT)).toMatchObject({
      kind: 'unresolved',
      code: 'authority-policy-ambiguous-match'
    });
  });
});

// ---------------------------------------------------------------------------
// Footgun 2 — a mis-pathed condition fails closed, and says so
// ---------------------------------------------------------------------------

describe('S4-P10 — footgun 2: a mis-pathed condition fails closed (DG-3)', () => {
  it('reports a mis-pathed condition as a distinct unresolved diagnostic, not a denial', () => {
    // `recipent` is a typo for `recipient`. Every request through this rule is
    // refused — the right direction — but an operator must be told the *path* did
    // not resolve, or they will go and debug a trade that was fine.
    const typoPolicy = policy([
      {
        ...SWAP_RULE,
        conditions: [{ field: 'transfer.recipent', op: 'address_is_owner' }]
      }
    ]);

    const verdict = evaluateAuthorityAction(typoPolicy, swapAction(), CONTEXT);

    expect(verdict.kind).toBe('unresolved');
    expect(verdict).toMatchObject({
      kind: 'unresolved',
      code: 'authority-field-path-unresolved',
      ruleId: 'swap-on-router',
      field: 'transfer.recipent'
    });
    // It must not present as a generic denial...
    expect(verdict.kind).not.toBe('deny');
    // ...and it must still refuse.
    expect(isPermitted(verdict)).toBe(false);
    if (verdict.kind !== 'unresolved') return;
    // The diagnostic names what was actually available, so the fix is one read.
    expect(verdict.reason).toContain('recipient');
    expect(verdict.reason).toContain('amountIn');
  });

  it('reports a mis-pathed nested struct field with the keys that were available', () => {
    const permitPolicy = policy([
      {
        id: 'permit2-single',
        effect: 'allow',
        scope: { kind: 'signed-struct', verifyingContracts: [PERMIT2], primaryType: 'PermitSingle' },
        conditions: [
          { field: 'message.spender', op: 'address_in', addresses: [ROUTER] },
          { field: 'message.details.amounts', op: 'uint_lte', max: '1000' }
        ]
      }
    ]);
    const verdict = evaluateAuthorityAction(permitPolicy, permitAction(), CONTEXT);
    expect(verdict).toMatchObject({
      kind: 'unresolved',
      code: 'authority-field-path-unresolved',
      field: 'message.details.amounts'
    });
    if (verdict.kind !== 'unresolved') return;
    expect(verdict.reason).toContain('amount');
  });

  it('reports a type-mismatched path distinctly from a mis-pathed one', () => {
    const wrongTypePolicy = policy([
      {
        ...SWAP_RULE,
        conditions: [{ field: 'transfer.amountIn', op: 'address_is_owner' }]
      }
    ]);
    expect(evaluateAuthorityAction(wrongTypePolicy, swapAction(), CONTEXT)).toMatchObject({
      kind: 'unresolved',
      code: 'authority-field-type-mismatch',
      field: 'transfer.amountIn'
    });
  });

  it('reports a path that lands on a nested struct as a type mismatch, not a value', () => {
    const structPolicy = policy([
      {
        id: 'permit2-single',
        effect: 'allow',
        scope: { kind: 'signed-struct', verifyingContracts: [PERMIT2], primaryType: 'PermitSingle' },
        conditions: [
          { field: 'message.spender', op: 'address_in', addresses: [ROUTER] },
          { field: 'message.details.amount', op: 'uint_lte', max: '1000' },
          { field: 'message.details', op: 'address_in', addresses: [ROUTER] }
        ]
      }
    ]);
    expect(evaluateAuthorityAction(structPolicy, permitAction(), CONTEXT)).toMatchObject({
      kind: 'unresolved',
      code: 'authority-field-type-mismatch',
      field: 'message.details'
    });
  });

  it('catches the commonest mis-path at construction: a root the rule does not permit', () => {
    expect(() =>
      policy([
        {
          ...SWAP_RULE,
          conditions: [{ field: 'transfer.amount', op: 'uint_lte', max: '1' }]
        }
      ])
    ).toThrow(expect.objectContaining({ code: 'authority-policy-invalid-field-path' }));
  });

  it('rejects a call-metadata path that names no real field', () => {
    expect(() =>
      policy([
        {
          ...SWAP_RULE,
          conditions: [{ field: 'call.gasLimit', op: 'uint_lte', max: '1' }]
        }
      ])
    ).toThrow(expect.objectContaining({ code: 'authority-policy-invalid-field-path' }));
  });

  it('reports an owner account that is not an address as a type mismatch, never a pass', () => {
    const verdict = evaluateAuthorityAction(policy(), swapAction(), {
      ...CONTEXT,
      ownerAccount: 'not-an-address'
    });
    expect(verdict).toMatchObject({
      kind: 'unresolved',
      code: 'authority-field-type-mismatch'
    });
  });

  it('refuses a UserOperation whose selector has no descriptor, under its own code', () => {
    const verdict = authorizeUserOperationCall(
      policy(),
      {
        chainId: ROBINHOOD_CHAIN_ID,
        sender: ACCOUNT,
        callData: encodeExecute(TOKEN, 0n, `0xdeadbeef${uintWord(1n)}`)
      },
      DESCRIPTORS,
      CONTEXT
    );
    expect(verdict).toMatchObject({
      kind: 'unresolved',
      code: 'authority-action-unknown-selector'
    });
    expect(isPermitted(verdict)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Permit2 / signed structs (S4-M13 forward compatibility)
// ---------------------------------------------------------------------------

function permitAction(
  overrides: { spender?: string; amount?: bigint; token?: string; deadline?: bigint } = {}
): AuthoritySignedStruct {
  return {
    kind: 'signed-struct',
    chainId: ROBINHOOD_CHAIN_ID,
    primaryType: 'PermitSingle',
    verifyingContract: PERMIT2,
    message: {
      details: {
        token: overrides.token ?? TOKEN,
        amount: overrides.amount ?? 500n,
        expiration: BigInt(NOW + 600),
        nonce: 0n
      },
      spender: overrides.spender ?? ROUTER,
      sigDeadline: overrides.deadline ?? BigInt(NOW + 600)
    }
  };
}

const PERMIT_RULE = {
  id: 'permit2-single',
  effect: 'allow',
  scope: { kind: 'signed-struct', verifyingContracts: [PERMIT2], primaryType: 'PermitSingle' },
  conditions: [
    { field: 'message.details.token', op: 'address_in', addresses: [TOKEN] },
    { field: 'message.spender', op: 'address_in', addresses: [ROUTER] },
    { field: 'message.details.amount', op: 'uint_lte', max: APPROVE_CAP.toString() },
    { field: 'message.sigDeadline', op: 'uint_lte_now_plus', maxSecondsAhead: 1800 }
  ]
};

describe('S4-P10 — the same conditions bind a Permit2 permit (S4-M13)', () => {
  it('permits a permit whose token, spender, amount and deadline all hold', () => {
    expect(evaluateAuthorityAction(policy([PERMIT_RULE]), permitAction(), CONTEXT)).toMatchObject({
      kind: 'permit',
      ruleId: 'permit2-single',
      matched: 'PermitSingle'
    });
  });

  it('denies a permit granting allowance to a non-allowlisted spender', () => {
    expect(
      evaluateAuthorityAction(policy([PERMIT_RULE]), permitAction({ spender: ATTACKER }), CONTEXT)
    ).toMatchObject({
      kind: 'deny',
      code: 'authority-deny-condition-failed',
      field: 'message.spender'
    });
  });

  it('denies a permit whose amount exceeds the bound', () => {
    expect(
      evaluateAuthorityAction(
        policy([PERMIT_RULE]),
        permitAction({ amount: APPROVE_CAP + 1n }),
        CONTEXT
      )
    ).toMatchObject({ kind: 'deny', field: 'message.details.amount' });
  });

  it('denies a permit whose deadline is further ahead than the window allows', () => {
    expect(
      evaluateAuthorityAction(
        policy([PERMIT_RULE]),
        permitAction({ deadline: BigInt(NOW + 4000) }),
        CONTEXT
      )
    ).toMatchObject({ kind: 'deny', field: 'message.sigDeadline' });
  });

  it('denies a permit signed against a verifying contract that is not the pinned Permit2', () => {
    expect(
      evaluateAuthorityAction(
        policy([PERMIT_RULE]),
        { ...permitAction(), verifyingContract: ATTACKER },
        CONTEXT
      )
    ).toMatchObject({ kind: 'deny', code: 'authority-deny-no-matching-rule' });
  });

  it('denies a different primary type against the same verifying contract', () => {
    expect(
      evaluateAuthorityAction(
        policy([PERMIT_RULE]),
        { ...permitAction(), primaryType: 'Batch' },
        CONTEXT
      )
    ).toMatchObject({ kind: 'deny', code: 'authority-deny-no-matching-rule' });
  });

  it('refuses at construction a permit rule with no amount bound', () => {
    expect(() =>
      policy([
        {
          ...PERMIT_RULE,
          conditions: [{ field: 'message.spender', op: 'address_in', addresses: [ROUTER] }]
        }
      ])
    ).toThrow(expect.objectContaining({ code: 'authority-policy-invalid-unbounded-approval' }));
  });

  it('refuses at construction a permit rule with no address constraint', () => {
    expect(() =>
      policy([
        {
          ...PERMIT_RULE,
          conditions: [{ field: 'message.details.amount', op: 'uint_lte', max: '1000' }]
        }
      ])
    ).toThrow(expect.objectContaining({ code: 'authority-policy-invalid-unbounded-approval' }));
  });

  it.each([
    'Permit',
    'PermitSingle',
    'PermitBatch',
    'PermitTransferFrom',
    'PermitBatchTransferFrom',
    'PermitWitnessTransferFrom',
    'PermitBatchWitnessTransferFrom'
  ])('applies the structural check to every spending-authority primary type: %s', (primaryType) => {
    // Verified against permit2/src/libraries/PermitHash.sol on 2026-08-25. The
    // two witness variants were missing from the first draft of
    // ALLOWANCE_PRIMARY_TYPES, and a name missing from that list means the
    // structural check is SILENTLY SKIPPED for it -- an unbounded permit rule
    // would compile clean. That is the dangerous direction to be wrong in, so the
    // list is pinned by enumeration rather than by spot-checking one member.
    expect(() =>
      policy([
        {
          ...PERMIT_RULE,
          scope: { kind: 'signed-struct', verifyingContracts: [PERMIT2], primaryType },
          conditions: [{ field: 'message.details.amount', op: 'uint_lte', max: '1000' }]
        }
      ])
    ).toThrow(expect.objectContaining({ code: 'authority-policy-invalid-unbounded-approval' }));
  });

  it('does not apply the structural check to a sub-struct type that can never be a primaryType', () => {
    // PermitDetails and TokenPermissions are referenced BY the permit types, never
    // signed on their own, so a rule scoped to one could not match a real request.
    // Including them would be harmless but misleading; excluding them is the claim
    // being pinned here.
    expect(() =>
      policy([
        {
          ...PERMIT_RULE,
          scope: { kind: 'signed-struct', verifyingContracts: [PERMIT2], primaryType: 'PermitDetails' },
          conditions: [{ field: 'message.amount', op: 'uint_lte', max: '1000' }]
        }
      ])
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Document validation
// ---------------------------------------------------------------------------

describe('S4-P10 — document validation', () => {
  it('rejects a non-object document', () => {
    expect(() => compileAuthorityPolicy(null)).toThrow(
      expect.objectContaining({ code: 'authority-policy-invalid-document' })
    );
  });

  it('rejects a missing or non-numeric chainId', () => {
    expect(() => compileAuthorityPolicy({ rules: [] })).toThrow(
      expect.objectContaining({ code: 'authority-policy-invalid-document' })
    );
  });

  it('rejects an unsupported document version rather than best-effort parsing it', () => {
    expect(() =>
      compileAuthorityPolicy({ version: 2, chainId: ROBINHOOD_CHAIN_ID, rules: [] })
    ).toThrow(expect.objectContaining({ code: 'authority-policy-invalid-document' }));
  });

  it('rejects a malformed selector', () => {
    expect(() =>
      policy([{ ...SWAP_RULE, scope: { ...SWAP_RULE.scope, selector: '0x1234' } }])
    ).toThrow(expect.objectContaining({ code: 'authority-policy-invalid-document' }));
  });

  it('rejects a malformed address in a scope', () => {
    expect(() =>
      policy([{ ...SWAP_RULE, scope: { ...SWAP_RULE.scope, targets: ['0xnope'] } }])
    ).toThrow(expect.objectContaining({ code: 'authority-policy-invalid-address' }));
  });

  it('rejects a malformed address in an allowlist', () => {
    expect(() =>
      policy([
        {
          ...APPROVE_RULE,
          conditions: [
            { field: 'approve.spender', op: 'address_in', addresses: ['0x12'] },
            { field: 'approve.amount', op: 'uint_lte', max: '1' }
          ]
        }
      ])
    ).toThrow(expect.objectContaining({ code: 'authority-policy-invalid-address' }));
  });

  it('rejects an unknown condition op', () => {
    expect(() =>
      policy([{ ...SWAP_RULE, conditions: [{ field: 'transfer.recipient', op: 'regex' }] }])
    ).toThrow(expect.objectContaining({ code: 'authority-policy-invalid-document' }));
  });

  it('rejects a negative amount bound', () => {
    expect(() =>
      policy([
        {
          ...APPROVE_RULE,
          conditions: [
            { field: 'approve.spender', op: 'address_in', addresses: [ROUTER] },
            { field: 'approve.amount', op: 'uint_lte', max: -1n }
          ]
        }
      ])
    ).toThrow(expect.objectContaining({ code: 'authority-policy-invalid-amount' }));
  });

  it('normalises addresses and amounts onto the compiled policy', () => {
    const compiled = policy();
    const rule = compiled.rules[0]!;
    expect(rule.scope.kind).toBe('contract-call');
    if (rule.scope.kind !== 'contract-call') return;
    expect(rule.scope.targets).toEqual([TOKEN]);
    expect(rule.conditions[1]).toMatchObject({ op: 'uint_lte', max: APPROVE_CAP });
    expect(rule.maxNativeValue).toBe(0n);
  });

  it('carries a stable code on every construction failure', () => {
    try {
      compileAuthorityPolicy({ chainId: 0, rules: [] });
      throw new Error('expected a throw');
    } catch (error) {
      expect(error).toBeInstanceOf(AuthorityPolicyError);
      expect(typeof (error as AuthorityPolicyError).code).toBe('string');
    }
  });
});
