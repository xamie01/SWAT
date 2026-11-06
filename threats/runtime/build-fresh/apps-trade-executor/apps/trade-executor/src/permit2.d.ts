import { type Hex } from 'viem';
/**
 * Permit2 payload construction (`S4-M13`).
 *
 * **Read the Phase 1 caveat before wiring this.** This module is *unwired*. It
 * builds correct Permit2 payloads and correct `Permit2`-contract calldata, both
 * verified against Uniswap's own published source and against live on-chain
 * domain separators (see `permit2.test.ts`). What it deliberately does **not**
 * do is emit swap-router calldata, because the router this repo currently calls
 * cannot consume a Permit2 signature at all:
 *
 * - `robinhood.ts` calls a Uniswap **V3 SwapRouter01/02** (`ROBINHOOD_SWAP_ROUTER`,
 *   ABI chosen by `ROBINHOOD_ROUTER_ABI_VERSION`). Neither router knows about
 *   Permit2. `SwapRouter02`'s inheritance list is
 *   `ISwapRouter02, V2SwapRouter, V3SwapRouter, ApproveAndCall, MulticallExtended, SelfPermit`
 *   — and `SelfPermit` is **EIP-2612 token-level permit**, a different mechanism
 *   that requires the *token* to implement `permit`. Permit2 integration lives in
 *   the Universal Router, not in either SwapRouter.
 * - Permit2 itself *is* deployed on Robinhood Chain (4663) at the canonical
 *   address, confirmed both by Robinhood's own protocol-contracts page and by
 *   `eth_getCode` (9152 bytes) plus a live `DOMAIN_SEPARATOR()` read.
 *
 * So the missing fact is the router, not Permit2. Until a Permit2-aware router
 * address on 4663 is confirmed, assembling `execute(bytes,bytes[])` command
 * calldata would be building against an interface nobody has verified is
 * reachable, which is worse than leaving the seam open.
 *
 * **No signing here, by design (`S4-P7`).** Every builder returns a
 * `TypedDataDefinition` for something else to sign. This module never accepts a
 * private key and never produces a signature: the permit is a signature like any
 * other, so it flows through the `UserExecutionAuthority` port rather than being
 * a special-cased transaction.
 *
 * **Policy inspection is structural (`S4-P10`).** Every plan carries a flat
 * {@link Permit2PolicySubject} exposing token / spender / amount / deadline as
 * plain fields *before* anything is signed. A policy engine must never have to
 * decode a blob to find out what it is about to authorise — that is the
 * `approve`-spender hole reappearing in a new costume.
 */
/**
 * The canonical, deterministic Permit2 deployment address.
 *
 * The same on every chain that has one, because Permit2 is deployed via a
 * deterministic deployer. Verified present on Robinhood Chain (4663) — listed in
 * `docs.robinhood.com/chain/protocol-contracts` under "Misc (L2)" for both
 * mainnet and testnet, and confirmed by `eth_getCode` returning 9152 bytes.
 *
 * Kept as a checksummed literal rather than an env var **on purpose**: a
 * mistyped Permit2 address does not fail loudly, it silently produces a domain
 * separator nobody will ever counter-sign, and the failure surfaces as an
 * unexplained `InvalidSigner` revert. Callers that genuinely need to override it
 * (a fork, a test chain) pass `permit2` explicitly and eat the risk visibly.
 */
export declare const CANONICAL_PERMIT2_ADDRESS: "0x000000000022D473030F116dDEE9F6B43aC78BA3";
/** ERC-20 `approve(address,uint256)` selector, used to *prove absence*. */
export declare const ERC20_APPROVE_SELECTOR: "0x095ea7b3";
/** `uint160` ceiling — the width of `PermitDetails.amount`. */
export declare const MAX_PERMIT2_ALLOWANCE_AMOUNT: bigint;
/** `uint48` ceiling — the width of `PermitDetails.expiration` and `.nonce`. */
export declare const MAX_UINT48: bigint;
/** `uint256` ceiling — the width of a SignatureTransfer unordered nonce. */
export declare const MAX_UINT256: bigint;
/**
 * Which of Permit2's two halves a payload targets.
 *
 * Permit2 is documented as "a unification of 2 contracts, `SignatureTransfer`
 * and `AllowanceTransfer`". They are not interchangeable and — the part that
 * bites — **they do not share nonce semantics**. See {@link Permit2NonceSpace}.
 */
export type Permit2Kind = 'allowance-transfer' | 'signature-transfer';
/**
 * How a nonce is validated on-chain. The two are genuinely different mechanisms.
 *
 * - `sequential-uint48` — `AllowanceTransfer` / `PermitSingle`. A plain
 *   incrementing counter stored per `(owner, token, spender)` inside
 *   `PackedAllowance`. `_updateApproval` does `if (allowed.nonce != nonce)
 *   revert InvalidNonce();` then stores `nonce + 1`. The signed nonce must equal
 *   the currently stored one **exactly**; permits for one triple are therefore
 *   consumed strictly in order.
 * - `unordered-bitmap-uint256` — `SignatureTransfer` / `PermitTransferFrom`. A
 *   `uint256` split into `wordPos = nonce >> 8` and `bitPos = uint8(nonce)`,
 *   indexing `nonceBitmap[owner][wordPos]`. `_useUnorderedNonce` XORs the bit in
 *   and reverts `InvalidNonce` if it was already set. Any unused bit is valid,
 *   in any order.
 *
 * Note the asymmetry that a lot of integration code gets wrong: only the
 * *unordered* half is a bitmap. It is common to read "Permit2 uses unordered
 * nonces" and apply that to `PermitSingle`, which then reverts `InvalidNonce`
 * the moment the value is anything other than the stored counter.
 */
export type Permit2NonceSpace = 'sequential-uint48' | 'unordered-bitmap-uint256';
/**
 * Everything a policy engine needs, flat and pre-signature (`S4-P10`).
 *
 * This is the whole point of the module's shape. `S4-M13` deletes the `approve`
 * call that `S4-P10` was going to constrain by spender, so the argument-level
 * check has to move onto these fields instead. If they were only reachable by
 * decoding `typedData`, every policy implementation would have to re-derive
 * Permit2's ABI, and the ones that got it subtly wrong would fail *open*.
 */
export type Permit2PolicySubject = {
    kind: Permit2Kind;
    chainId: number;
    /** The Permit2 instance that will verify the signature. */
    permit2: `0x${string}`;
    /** The account whose tokens move. The signer must be this address. */
    owner: `0x${string}`;
    /** The ERC-20 being permitted. */
    token: `0x${string}`;
    /**
     * The address authorised to pull the tokens.
     *
     * For `signature-transfer` this address is **not** present in the on-chain
     * struct — Permit2 substitutes `msg.sender` when it rebuilds the digest. It is
     * still signed over, so it must equal whoever will call `permitTransferFrom`,
     * and a policy engine must be able to see it. Hence it lives here.
     */
    spender: `0x${string}`;
    /** Maximum spendable: `uint160` for allowance-transfer, `uint256` otherwise. */
    amount: bigint;
    /** Unix seconds past which Permit2 reverts `SignatureExpired`. */
    sigDeadline: bigint;
    /**
     * Unix seconds at which the *allowance* lapses; `null` for signature-transfer,
     * which grants no standing allowance at all.
     */
    expiration: bigint | null;
    nonce: bigint;
    nonceSpace: Permit2NonceSpace;
};
/**
 * The signable payload, shaped to satisfy the `S4-P7` authority port.
 *
 * **Deliberately not viem's `TypedDataDefinition`.** That type declares `domain`
 * as optional and `domain.chainId` as `number | bigint`, so it is *not*
 * assignable to `ExecutionAuthority`'s `Eip712TypedData`, which requires a
 * present `domain` and a `number` chain id. Returning viem's type directly would
 * push a cast onto every call site in the authority adapters — and a cast at the
 * boundary is exactly where a genuinely malformed payload would slip through.
 *
 * So this narrows to what is actually always true here: the domain is always
 * built, `chainId` is always a `number`, and the primary type is one of two known
 * strings. The literals are still checked against viem's own type internally via
 * `satisfies`, so the field/type/message consistency viem enforces is not lost.
 *
 * Declared structurally rather than imported from `execution-authority.ts` so
 * this module does not depend on a port that is being refactored concurrently;
 * `permit2.test.ts` pins the shape so drift is caught.
 */
export type Permit2TypedData = {
    readonly domain: {
        readonly name: 'Permit2';
        readonly chainId: number;
        readonly verifyingContract: `0x${string}`;
    };
    readonly types: Readonly<Record<string, readonly {
        readonly name: string;
        readonly type: string;
    }[]>>;
    readonly primaryType: 'PermitSingle' | 'PermitTransferFrom';
    readonly message: Readonly<Record<string, unknown>>;
};
/** A transaction call to submit once the signature exists. */
export type Permit2Call = {
    to: `0x${string}`;
    data: Hex;
    value: bigint;
    /** Why this call exists, so callers can log and assert without decoding. */
    purpose: 'permit2-enablement-approve' | 'permit2-permit' | 'permit2-transfer-from';
};
/**
 * A signable payload plus the calls it unlocks.
 *
 * `calls` is empty for the plans that only need a signature handed onward to a
 * router; it is populated when the caller intends to drive Permit2 directly.
 */
export type Permit2Plan = {
    subject: Permit2PolicySubject;
    typedData: Permit2TypedData;
    /** The EIP-712 digest that will be signed. Exposed for logging and tests. */
    digest: Hex;
    calls: Permit2Call[];
};
/**
 * The Permit2 EIP-712 domain.
 *
 * **There is no `version` field, and that is not an omission.** Permit2's
 * `EIP712.sol` hashes the preimage
 * `"EIP712Domain(string name,uint256 chainId,address verifyingContract)"` — four
 * members, no `version`, no `salt`. Adding `version: '1'` (the reflex, since
 * almost every other EIP-712 domain has one) changes the domain separator and
 * every resulting signature verifies as a *different signer*, so it surfaces as
 * `InvalidSigner` rather than as anything that points at the domain.
 *
 * Verified against two live deployments in `permit2.test.ts`.
 */
export declare function permit2Domain(input: {
    chainId: number;
    permit2?: `0x${string}`;
}): {
    name: 'Permit2';
    chainId: number;
    verifyingContract: `0x${string}`;
};
/**
 * The EIP-712 domain type, spelled out.
 *
 * viem infers this from the domain's keys when hashing typed data, but the
 * inference is exactly the thing worth pinning: if `permit2Domain` ever gained a
 * `version` key the inferred type would silently follow it, and every signature
 * would start verifying as a different signer with no test failing. Declaring it
 * explicitly means the separator is computed from a fixed type regardless.
 */
export declare const PERMIT2_EIP712_DOMAIN_TYPE: readonly [{
    readonly name: "name";
    readonly type: "string";
}, {
    readonly name: "chainId";
    readonly type: "uint256";
}, {
    readonly name: "verifyingContract";
    readonly type: "address";
}];
/**
 * The `DOMAIN_SEPARATOR()` Permit2 would return on `chainId`.
 *
 * Pure, so it can be checked against a live `eth_call` without this module ever
 * making one. `permit2.test.ts` pins it against two real deployments.
 */
export declare function permit2DomainSeparator(input: {
    chainId: number;
    permit2?: `0x${string}`;
}): Hex;
/**
 * EIP-712 types for `AllowanceTransfer`.
 *
 * Field order and widths mirror `IAllowanceTransfer.sol` exactly. The widths are
 * load-bearing: `amount` is `uint160` (not `uint256`) and `expiration`/`nonce`
 * are `uint48`, because all three pack into one storage slot. Widening any of
 * them here changes the struct hash.
 */
export declare const PERMIT2_ALLOWANCE_TRANSFER_TYPES: {
    readonly PermitDetails: readonly [{
        readonly name: "token";
        readonly type: "address";
    }, {
        readonly name: "amount";
        readonly type: "uint160";
    }, {
        readonly name: "expiration";
        readonly type: "uint48";
    }, {
        readonly name: "nonce";
        readonly type: "uint48";
    }];
    readonly PermitSingle: readonly [{
        readonly name: "details";
        readonly type: "PermitDetails";
    }, {
        readonly name: "spender";
        readonly type: "address";
    }, {
        readonly name: "sigDeadline";
        readonly type: "uint256";
    }];
};
/**
 * EIP-712 types for `SignatureTransfer`.
 *
 * `PermitTransferFrom` carries `spender` in the *signed* type even though the
 * on-chain struct does not — Permit2 hashes `msg.sender` into that position. The
 * signed type and the ABI struct therefore differ by one field, deliberately.
 */
export declare const PERMIT2_SIGNATURE_TRANSFER_TYPES: {
    readonly TokenPermissions: readonly [{
        readonly name: "token";
        readonly type: "address";
    }, {
        readonly name: "amount";
        readonly type: "uint256";
    }];
    readonly PermitTransferFrom: readonly [{
        readonly name: "permitted";
        readonly type: "TokenPermissions";
    }, {
        readonly name: "spender";
        readonly type: "address";
    }, {
        readonly name: "nonce";
        readonly type: "uint256";
    }, {
        readonly name: "deadline";
        readonly type: "uint256";
    }];
};
/** Permit2 ABI fragments. Transcribed from the published interfaces. */
export declare const PERMIT2_ABI: readonly [{
    readonly name: "permit";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "owner";
    }, {
        readonly type: "tuple";
        readonly components: readonly [{
            readonly name: "details";
            readonly type: "tuple";
            readonly components: readonly [{
                readonly type: "address";
                readonly name: "token";
            }, {
                readonly type: "uint160";
                readonly name: "amount";
            }, {
                readonly type: "uint48";
                readonly name: "expiration";
            }, {
                readonly type: "uint48";
                readonly name: "nonce";
            }];
        }, {
            readonly type: "address";
            readonly name: "spender";
        }, {
            readonly type: "uint256";
            readonly name: "sigDeadline";
        }];
        readonly name: "permitSingle";
    }, {
        readonly type: "bytes";
        readonly name: "signature";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "permitTransferFrom";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "tuple";
        readonly components: readonly [{
            readonly name: "permitted";
            readonly type: "tuple";
            readonly components: readonly [{
                readonly type: "address";
                readonly name: "token";
            }, {
                readonly type: "uint256";
                readonly name: "amount";
            }];
        }, {
            readonly type: "uint256";
            readonly name: "nonce";
        }, {
            readonly type: "uint256";
            readonly name: "deadline";
        }];
        readonly name: "permit";
    }, {
        readonly type: "tuple";
        readonly components: readonly [{
            readonly type: "address";
            readonly name: "to";
        }, {
            readonly type: "uint256";
            readonly name: "requestedAmount";
        }];
        readonly name: "transferDetails";
    }, {
        readonly type: "address";
        readonly name: "owner";
    }, {
        readonly type: "bytes";
        readonly name: "signature";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "allowance";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "owner";
    }, {
        readonly type: "address";
        readonly name: "token";
    }, {
        readonly type: "address";
        readonly name: "spender";
    }];
    readonly outputs: readonly [{
        readonly type: "uint160";
        readonly name: "amount";
    }, {
        readonly type: "uint48";
        readonly name: "expiration";
    }, {
        readonly type: "uint48";
        readonly name: "nonce";
    }];
}, {
    readonly name: "nonceBitmap";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "owner";
    }, {
        readonly type: "uint256";
        readonly name: "wordPos";
    }];
    readonly outputs: readonly [{
        readonly type: "uint256";
    }];
}, {
    readonly name: "DOMAIN_SEPARATOR";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly type: "bytes32";
    }];
}];
/**
 * Rejects a `sigDeadline` that is already past at `nowSeconds`.
 *
 * Permit2's check is `if (block.timestamp > sigDeadline) revert
 * SignatureExpired(sigDeadline)`, so equality is still valid — the permit is
 * live *through* its deadline second, not up to it. Mirrored exactly here rather
 * than approximated with `>=`, because an off-by-one in the safe direction still
 * means we reject payloads the chain would have accepted, and an off-by-one the
 * other way means we ask a user to sign something guaranteed to revert.
 */
export declare function assertPermit2DeadlineUnexpired(input: {
    sigDeadline: bigint;
    nowSeconds: bigint;
}): void;
/**
 * Splits a SignatureTransfer nonce into its bitmap coordinates.
 *
 * Mirrors Permit2's private `bitmapPositions`: the high 248 bits select the word
 * in `nonceBitmap[owner]`, the low 8 bits select the bit inside it. One word
 * therefore tracks 256 nonces.
 */
export declare function permit2BitmapPosition(nonce: bigint): {
    wordPos: bigint;
    bitPos: number;
};
/**
 * Whether `nonce` has already been spent, given the on-chain bitmap word.
 *
 * `bitmapWord` must be `nonceBitmap[owner][wordPos]` for the *matching*
 * `wordPos` — passing the wrong word answers a different question and answers it
 * confidently, so callers should derive both from {@link permit2BitmapPosition}.
 */
export declare function isPermit2NonceUsed(input: {
    nonce: bigint;
    bitmapWord: bigint;
}): boolean;
/**
 * Lowest unspent nonce in one bitmap word, or `null` if all 256 are spent.
 *
 * **This is not the EVM transaction nonce and must never be derived from it.**
 * The transaction nonce is per-account, strictly sequential, and consumed by the
 * node when a transaction lands; this one is per-`(owner, wordPos)`, unordered,
 * and consumed by the Permit2 contract when a *signature* is redeemed. They
 * advance independently: a permit signed but never submitted burns no
 * transaction nonce, and a failed transaction burns a transaction nonce while
 * leaving the Permit2 bit clear. `packages/db/src/evm-nonce.ts`
 * (`withEvmNonceLock`) and `withSubmissionLock` in `robinhood.ts` serialise the
 * *transaction* nonce; neither one protects this.
 *
 * Which matters here because the exclusion those locks provide is per-account,
 * and it happens to be sufficient — while one process holds the account's lock,
 * no other process is choosing a Permit2 nonce for that account either. Two
 * concurrent permits under the same lock would both read the same bitmap word
 * and both pick the same bit; the second reverts `InvalidNonce`. So Permit2
 * nonce selection has to sit *inside* the existing lock, not beside it. Reusing
 * the lock is correct; reusing the *number* is not.
 */
export declare function nextUnusedPermit2Nonce(input: {
    wordPos: bigint;
    bitmapWord: bigint;
}): bigint | null;
/**
 * Builds the `PermitSingle` payload for `AllowanceTransfer`.
 *
 * `nonce` must be the value currently stored at
 * `Permit2.allowance(owner, token, spender).nonce` — not "the next one", not the
 * transaction nonce. Permit2 compares for equality and increments itself.
 */
export declare function buildPermit2AllowancePlan(input: {
    chainId: number;
    owner: `0x${string}`;
    token: `0x${string}`;
    spender: `0x${string}`;
    amount: bigint;
    /** Unix seconds at which the allowance lapses. */
    expiration: bigint;
    /** Unix seconds after which the signature is dead. */
    sigDeadline: bigint;
    /** Current on-chain allowance nonce for `(owner, token, spender)`. */
    nonce: bigint;
    /** For the deadline sanity check. Injected, so this stays pure. */
    nowSeconds: bigint;
    permit2?: `0x${string}`;
    /**
     * Emit the `Permit2.permit(...)` call as well as the payload.
     *
     * Off by default: a Permit2-aware router consumes the signature inline (the
     * Universal Router's `PERMIT2_PERMIT` command), so a separate `permit`
     * transaction would defeat the single-transaction goal that `S4-M13` exists to
     * achieve. Turn it on only when driving Permit2 directly.
     */
    emitPermitCall?: boolean;
    /**
     * Placeholder signature used purely to shape the `permit` calldata.
     *
     * Required when `emitPermitCall` is set. This module never signs, so the
     * caller supplies the signature it obtained from the authority port.
     */
    signature?: Hex;
    /**
     * Permit `expiration: 0`, which Permit2 reads as a sentinel.
     *
     * `Allowance.updateAll` stores `expiration == 0 ? uint48(block.timestamp)`, so
     * a zero expiration does not mean "never expires" — it means the allowance
     * lives for exactly one block. Almost always a bug, so it must be opted into.
     */
    allowBlockScopedExpiration?: boolean;
}): Permit2Plan;
/**
 * Builds the `PermitTransferFrom` payload for `SignatureTransfer`.
 *
 * The signed message includes `spender`, but the ABI struct does not: Permit2
 * rebuilds the digest using `msg.sender`. So the address that submits
 * `permitTransferFrom` must be exactly `spender`, or verification fails with
 * `InvalidSigner` and gives no hint that the mismatch was the caller's identity.
 */
export declare function buildPermit2SignatureTransferPlan(input: {
    chainId: number;
    owner: `0x${string}`;
    token: `0x${string}`;
    /** The address that will call `permitTransferFrom`. Signed over. */
    spender: `0x${string}`;
    /** Ceiling authorised by the signature. */
    amount: bigint;
    /** Unix seconds after which the signature is dead. */
    deadline: bigint;
    /** An unspent unordered nonce — see {@link nextUnusedPermit2Nonce}. */
    nonce: bigint;
    nowSeconds: bigint;
    permit2?: `0x${string}`;
    /** Where the pulled tokens land. Defaults to `spender`. */
    transferTo?: `0x${string}`;
    /** Amount actually pulled; must be `<= amount`. Defaults to `amount`. */
    requestedAmount?: bigint;
    emitTransferCall?: boolean;
    signature?: Hex;
}): Permit2Plan;
/**
 * Whether the one-time `token.approve(permit2, …)` is still outstanding.
 *
 * **Permit2 does not abolish the ERC-20 approval; it relocates it.** Uniswap's
 * own documentation is explicit: "users must first approve the Permit2 contract
 * on the token itself before an integrating contract can pull their tokens". So
 * the honest claim for `S4-M13` is *one approve, once, per token* rather than
 * one approve per trade — not "no approve ever".
 *
 * What genuinely improves is the residual-allowance surface. See
 * {@link describePermit2AllowancePosture}.
 */
export declare function permit2EnablementRequired(input: {
    currentAllowanceToPermit2: bigint;
    amount: bigint;
}): boolean;
/**
 * The one-time enablement call: `token.approve(permit2, amount)`.
 *
 * Deliberately a *separate* function rather than something the plan builders
 * splice in, so the happy path provably emits no `approve` calldata and a test
 * can assert exactly that. Folding it in conditionally would make the absence
 * untestable without reproducing the condition.
 *
 * `amount` is not defaulted to `uint256` max. Unlimited is what Uniswap suggests
 * for general wallets, but this repo's posture is bounded approvals, and an
 * infinite standing allowance to Permit2 is precisely the risk this module is
 * supposed to be honest about.
 */
export declare function buildPermit2EnablementCall(input: {
    token: `0x${string}`;
    amount: bigint;
    permit2?: `0x${string}`;
}): Permit2Call;
/** True when `call` is an ERC-20 `approve`. Used to assert its absence. */
export declare function isErc20ApproveCall(call: Pick<Permit2Call, 'data'>): boolean;
/**
 * The residual-allowance posture, as required by `S4-M13`'s "done when".
 *
 * Written as data rather than prose in a markdown file so it cannot drift away
 * from the code it describes.
 */
export declare function describePermit2AllowancePosture(): {
    standingAllowanceToRouter: 'none';
    standingAllowanceToPermit2: 'bounded-or-unlimited-one-time';
    approvalsPerTrade: 0;
    approvalsPerTokenLifetime: 1;
    notes: string[];
};
//# sourceMappingURL=permit2.d.ts.map