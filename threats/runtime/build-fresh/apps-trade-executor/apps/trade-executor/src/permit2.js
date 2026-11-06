import { encodeFunctionData, erc20Abi, getAddress, hashDomain, hashTypedData, parseAbi } from 'viem';
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
export const CANONICAL_PERMIT2_ADDRESS = '0x000000000022D473030F116dDEE9F6B43aC78BA3';
/** ERC-20 `approve(address,uint256)` selector, used to *prove absence*. */
export const ERC20_APPROVE_SELECTOR = '0x095ea7b3';
/** `uint160` ceiling — the width of `PermitDetails.amount`. */
export const MAX_PERMIT2_ALLOWANCE_AMOUNT = (1n << 160n) - 1n;
/** `uint48` ceiling — the width of `PermitDetails.expiration` and `.nonce`. */
export const MAX_UINT48 = (1n << 48n) - 1n;
/** `uint256` ceiling — the width of a SignatureTransfer unordered nonce. */
export const MAX_UINT256 = (1n << 256n) - 1n;
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
export function permit2Domain(input) {
    if (!Number.isSafeInteger(input.chainId) || input.chainId <= 0) {
        throw new Error('permit2Domain requires a positive integer chainId');
    }
    return {
        name: 'Permit2',
        chainId: input.chainId,
        verifyingContract: getAddress(input.permit2 ?? CANONICAL_PERMIT2_ADDRESS)
    };
}
/**
 * The EIP-712 domain type, spelled out.
 *
 * viem infers this from the domain's keys when hashing typed data, but the
 * inference is exactly the thing worth pinning: if `permit2Domain` ever gained a
 * `version` key the inferred type would silently follow it, and every signature
 * would start verifying as a different signer with no test failing. Declaring it
 * explicitly means the separator is computed from a fixed type regardless.
 */
export const PERMIT2_EIP712_DOMAIN_TYPE = [
    { name: 'name', type: 'string' },
    { name: 'chainId', type: 'uint256' },
    { name: 'verifyingContract', type: 'address' }
];
/**
 * The `DOMAIN_SEPARATOR()` Permit2 would return on `chainId`.
 *
 * Pure, so it can be checked against a live `eth_call` without this module ever
 * making one. `permit2.test.ts` pins it against two real deployments.
 */
export function permit2DomainSeparator(input) {
    const domain = permit2Domain(input);
    return hashDomain({
        // `chainId` is `uint256` in the domain type, so it is widened to `bigint`
        // here. `permit2Domain` keeps it a `number` because that is what viem's
        // `signTypedData` domain expects, and the signer is the primary consumer.
        domain: { ...domain, chainId: BigInt(domain.chainId) },
        types: { EIP712Domain: [...PERMIT2_EIP712_DOMAIN_TYPE] }
    });
}
/**
 * EIP-712 types for `AllowanceTransfer`.
 *
 * Field order and widths mirror `IAllowanceTransfer.sol` exactly. The widths are
 * load-bearing: `amount` is `uint160` (not `uint256`) and `expiration`/`nonce`
 * are `uint48`, because all three pack into one storage slot. Widening any of
 * them here changes the struct hash.
 */
export const PERMIT2_ALLOWANCE_TRANSFER_TYPES = {
    PermitDetails: [
        { name: 'token', type: 'address' },
        { name: 'amount', type: 'uint160' },
        { name: 'expiration', type: 'uint48' },
        { name: 'nonce', type: 'uint48' }
    ],
    PermitSingle: [
        { name: 'details', type: 'PermitDetails' },
        { name: 'spender', type: 'address' },
        { name: 'sigDeadline', type: 'uint256' }
    ]
};
/**
 * EIP-712 types for `SignatureTransfer`.
 *
 * `PermitTransferFrom` carries `spender` in the *signed* type even though the
 * on-chain struct does not — Permit2 hashes `msg.sender` into that position. The
 * signed type and the ABI struct therefore differ by one field, deliberately.
 */
export const PERMIT2_SIGNATURE_TRANSFER_TYPES = {
    TokenPermissions: [
        { name: 'token', type: 'address' },
        { name: 'amount', type: 'uint256' }
    ],
    PermitTransferFrom: [
        { name: 'permitted', type: 'TokenPermissions' },
        { name: 'spender', type: 'address' },
        { name: 'nonce', type: 'uint256' },
        { name: 'deadline', type: 'uint256' }
    ]
};
/** Permit2 ABI fragments. Transcribed from the published interfaces. */
export const PERMIT2_ABI = parseAbi([
    'struct PermitDetails { address token; uint160 amount; uint48 expiration; uint48 nonce; }',
    'struct PermitSingle { PermitDetails details; address spender; uint256 sigDeadline; }',
    'struct TokenPermissions { address token; uint256 amount; }',
    'struct PermitTransferFrom { TokenPermissions permitted; uint256 nonce; uint256 deadline; }',
    'struct SignatureTransferDetails { address to; uint256 requestedAmount; }',
    'function permit(address owner, PermitSingle permitSingle, bytes signature) external',
    'function permitTransferFrom(PermitTransferFrom permit, SignatureTransferDetails transferDetails, address owner, bytes signature) external',
    'function allowance(address owner, address token, address spender) external view returns (uint160 amount, uint48 expiration, uint48 nonce)',
    'function nonceBitmap(address owner, uint256 wordPos) external view returns (uint256)',
    'function DOMAIN_SEPARATOR() external view returns (bytes32)'
]);
function requireUnsigned(value, max, label) {
    if (value < 0n)
        throw new Error(`${label} must be non-negative`);
    if (value > max)
        throw new Error(`${label} exceeds its on-chain width`);
}
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
export function assertPermit2DeadlineUnexpired(input) {
    requireUnsigned(input.sigDeadline, MAX_UINT256, 'sigDeadline');
    if (input.nowSeconds > input.sigDeadline) {
        throw new Error(`Permit2 sigDeadline ${input.sigDeadline} is already expired at ${input.nowSeconds}`);
    }
}
/**
 * Splits a SignatureTransfer nonce into its bitmap coordinates.
 *
 * Mirrors Permit2's private `bitmapPositions`: the high 248 bits select the word
 * in `nonceBitmap[owner]`, the low 8 bits select the bit inside it. One word
 * therefore tracks 256 nonces.
 */
export function permit2BitmapPosition(nonce) {
    requireUnsigned(nonce, MAX_UINT256, 'nonce');
    return { wordPos: nonce >> 8n, bitPos: Number(nonce & 0xffn) };
}
/**
 * Whether `nonce` has already been spent, given the on-chain bitmap word.
 *
 * `bitmapWord` must be `nonceBitmap[owner][wordPos]` for the *matching*
 * `wordPos` — passing the wrong word answers a different question and answers it
 * confidently, so callers should derive both from {@link permit2BitmapPosition}.
 */
export function isPermit2NonceUsed(input) {
    requireUnsigned(input.bitmapWord, MAX_UINT256, 'bitmapWord');
    const { bitPos } = permit2BitmapPosition(input.nonce);
    return ((input.bitmapWord >> BigInt(bitPos)) & 1n) === 1n;
}
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
export function nextUnusedPermit2Nonce(input) {
    requireUnsigned(input.wordPos, MAX_UINT256 >> 8n, 'wordPos');
    requireUnsigned(input.bitmapWord, MAX_UINT256, 'bitmapWord');
    for (let bit = 0n; bit < 256n; bit += 1n) {
        if (((input.bitmapWord >> bit) & 1n) === 0n)
            return (input.wordPos << 8n) | bit;
    }
    return null;
}
/**
 * Builds the `PermitSingle` payload for `AllowanceTransfer`.
 *
 * `nonce` must be the value currently stored at
 * `Permit2.allowance(owner, token, spender).nonce` — not "the next one", not the
 * transaction nonce. Permit2 compares for equality and increments itself.
 */
export function buildPermit2AllowancePlan(input) {
    const domain = permit2Domain({ chainId: input.chainId, permit2: input.permit2 });
    const owner = getAddress(input.owner);
    const token = getAddress(input.token);
    const spender = getAddress(input.spender);
    requireUnsigned(input.amount, MAX_PERMIT2_ALLOWANCE_AMOUNT, 'amount');
    requireUnsigned(input.expiration, MAX_UINT48, 'expiration');
    requireUnsigned(input.nonce, MAX_UINT48, 'nonce');
    if (input.expiration === 0n && input.allowBlockScopedExpiration !== true) {
        throw new Error('expiration 0 makes the allowance last a single block; pass allowBlockScopedExpiration to accept that');
    }
    assertPermit2DeadlineUnexpired({ sigDeadline: input.sigDeadline, nowSeconds: input.nowSeconds });
    if (input.expiration !== 0n && input.expiration < input.nowSeconds) {
        throw new Error(`allowance expiration ${input.expiration} is already past at ${input.nowSeconds}`);
    }
    // `expiration` and `nonce` are `uint48` on-chain, and viem models any uint
    // narrower than 53 bits as `number`. Narrowing here is lossless — `uint48` max
    // is 281474976710655, comfortably inside `Number.MAX_SAFE_INTEGER` — and both
    // widths were already bounded above. The public API keeps `bigint` throughout
    // so callers never have to think about where the boundary is.
    const message = {
        details: {
            token,
            amount: input.amount,
            expiration: Number(input.expiration),
            nonce: Number(input.nonce)
        },
        spender,
        sigDeadline: input.sigDeadline
    };
    const typedData = {
        domain,
        types: PERMIT2_ALLOWANCE_TRANSFER_TYPES,
        primaryType: 'PermitSingle',
        message
    };
    const calls = [];
    if (input.emitPermitCall === true) {
        if (!input.signature) {
            throw new Error('emitPermitCall requires the signature produced by the authority port');
        }
        calls.push({
            to: domain.verifyingContract,
            data: encodeFunctionData({
                abi: PERMIT2_ABI,
                functionName: 'permit',
                args: [owner, message, input.signature]
            }),
            value: 0n,
            purpose: 'permit2-permit'
        });
    }
    return {
        subject: {
            kind: 'allowance-transfer',
            chainId: input.chainId,
            permit2: domain.verifyingContract,
            owner,
            token,
            spender,
            amount: input.amount,
            sigDeadline: input.sigDeadline,
            expiration: input.expiration,
            nonce: input.nonce,
            nonceSpace: 'sequential-uint48'
        },
        typedData,
        digest: hashTypedData(typedData),
        calls
    };
}
/**
 * Builds the `PermitTransferFrom` payload for `SignatureTransfer`.
 *
 * The signed message includes `spender`, but the ABI struct does not: Permit2
 * rebuilds the digest using `msg.sender`. So the address that submits
 * `permitTransferFrom` must be exactly `spender`, or verification fails with
 * `InvalidSigner` and gives no hint that the mismatch was the caller's identity.
 */
export function buildPermit2SignatureTransferPlan(input) {
    const domain = permit2Domain({ chainId: input.chainId, permit2: input.permit2 });
    const owner = getAddress(input.owner);
    const token = getAddress(input.token);
    const spender = getAddress(input.spender);
    const transferTo = getAddress(input.transferTo ?? input.spender);
    requireUnsigned(input.amount, MAX_UINT256, 'amount');
    requireUnsigned(input.nonce, MAX_UINT256, 'nonce');
    assertPermit2DeadlineUnexpired({ sigDeadline: input.deadline, nowSeconds: input.nowSeconds });
    const requestedAmount = input.requestedAmount ?? input.amount;
    requireUnsigned(requestedAmount, MAX_UINT256, 'requestedAmount');
    if (requestedAmount > input.amount) {
        // Permit2 reverts InvalidAmount; catching it here keeps a doomed payload
        // from ever reaching a signer, which is the cheaper place to fail.
        throw new Error(`requestedAmount ${requestedAmount} exceeds permitted ${input.amount}`);
    }
    const typedData = {
        domain,
        types: PERMIT2_SIGNATURE_TRANSFER_TYPES,
        primaryType: 'PermitTransferFrom',
        message: {
            permitted: { token, amount: input.amount },
            spender,
            nonce: input.nonce,
            deadline: input.deadline
        }
    };
    const calls = [];
    if (input.emitTransferCall === true) {
        if (!input.signature) {
            throw new Error('emitTransferCall requires the signature produced by the authority port');
        }
        calls.push({
            to: domain.verifyingContract,
            data: encodeFunctionData({
                abi: PERMIT2_ABI,
                functionName: 'permitTransferFrom',
                args: [
                    // Note the absent `spender`: it is signed but not transmitted.
                    { permitted: { token, amount: input.amount }, nonce: input.nonce, deadline: input.deadline },
                    { to: transferTo, requestedAmount },
                    owner,
                    input.signature
                ]
            }),
            value: 0n,
            purpose: 'permit2-transfer-from'
        });
    }
    return {
        subject: {
            kind: 'signature-transfer',
            chainId: input.chainId,
            permit2: domain.verifyingContract,
            owner,
            token,
            spender,
            amount: input.amount,
            sigDeadline: input.deadline,
            expiration: null,
            nonce: input.nonce,
            nonceSpace: 'unordered-bitmap-uint256'
        },
        typedData,
        digest: hashTypedData(typedData),
        calls
    };
}
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
export function permit2EnablementRequired(input) {
    requireUnsigned(input.currentAllowanceToPermit2, MAX_UINT256, 'currentAllowanceToPermit2');
    requireUnsigned(input.amount, MAX_UINT256, 'amount');
    return input.currentAllowanceToPermit2 < input.amount;
}
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
export function buildPermit2EnablementCall(input) {
    requireUnsigned(input.amount, MAX_UINT256, 'amount');
    if (input.amount === 0n)
        throw new Error('enablement amount must be positive');
    return {
        to: getAddress(input.token),
        data: encodeFunctionData({
            abi: erc20Abi,
            functionName: 'approve',
            args: [getAddress(input.permit2 ?? CANONICAL_PERMIT2_ADDRESS), input.amount]
        }),
        value: 0n,
        purpose: 'permit2-enablement-approve'
    };
}
/** True when `call` is an ERC-20 `approve`. Used to assert its absence. */
export function isErc20ApproveCall(call) {
    return call.data.slice(0, 10).toLowerCase() === ERC20_APPROVE_SELECTOR;
}
/**
 * The residual-allowance posture, as required by `S4-M13`'s "done when".
 *
 * Written as data rather than prose in a markdown file so it cannot drift away
 * from the code it describes.
 */
export function describePermit2AllowancePosture() {
    return {
        standingAllowanceToRouter: 'none',
        standingAllowanceToPermit2: 'bounded-or-unlimited-one-time',
        approvalsPerTrade: 0,
        approvalsPerTokenLifetime: 1,
        notes: [
            'Permit2 leaves no standing ERC-20 allowance to the swap router: the router is authorised per-signature, with an amount and a deadline, and AllowanceTransfer allowances additionally carry their own expiration.',
            'That is strictly better than the rolling bounded-allowance fallback this replaces, which left a live router allowance between trades.',
            'The standing allowance does not disappear, it moves: the user must approve Permit2 itself once per token. Permit2 is audited and very widely used, but it is a different risk surface, not an absent one — a Permit2 compromise would reach every token every user has enabled, whereas a router allowance reached one token for one router.',
            'Bounding the enablement amount keeps that blast radius finite. Approving uint256 max is the common wallet default and is explicitly not this module default.'
        ]
    };
}
//# sourceMappingURL=permit2.js.map