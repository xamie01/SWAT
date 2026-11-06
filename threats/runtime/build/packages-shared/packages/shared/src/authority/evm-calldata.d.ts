/**
 * Minimal EVM calldata decoding for the permission policy engine (`S4-P10`).
 *
 * **Moves to `packages/authority` with the rest of this directory** (checklist
 * §7.1).
 *
 * ## Why this exists rather than `viem`
 *
 * `viem@^2.55.1` is a dependency of `apps/api`, `apps/indexer`,
 * `apps/signal-engine` and `apps/trade-executor` — but **not** of
 * `packages/shared`, and pnpm's isolated `node_modules` means it is not
 * resolvable from here. Adding it would need a `pnpm install`. So the decoder
 * here is deliberately the *smallest correct* thing rather than a general ABI
 * decoder:
 *
 *   * argument types are `address`, `uint256`, `bool` (one static word each) and
 *     `bytes` (allowed **only** as the final argument, one dynamic tail);
 *   * anything else — arrays, structs, multiple dynamic arguments, `executeBatch`
 *     — has no descriptor and is refused, not partially decoded.
 *
 * That covers exactly what §2.1 needs to check: `approve(address,uint256)` on a
 * token, and the 4337 `execute(address,uint256,bytes)` wrapper it arrives inside.
 * Callers that already have `viem` (the trade executor) should decode richer
 * shapes there and hand `evaluateAuthorityAction` an `AuthorityContractCall`
 * directly — the engine does not require this module.
 *
 * ## Strictness is the feature
 *
 * Dirty high-order bits in an `address` word and non-0/1 `bool` words are
 * rejected rather than masked. A decoder that silently truncates disagrees with
 * whatever the EVM will actually do, and a policy that checks a value the chain
 * will not use is decoration.
 *
 * ## Selectors are constants, not computed
 *
 * There is no keccak256 in `packages/shared`, so selectors cannot be derived from
 * signatures here — they are written out as the published values below. A
 * consumer that has `viem` should assert them at startup with
 * `toFunctionSelector` rather than trust this file; the constants are marked so
 * that assertion is greppable.
 */
import type { AuthorityContractCall, AuthorityFieldValue } from './permission-policy.js';
export type EvmArgType = 'address' | 'uint256' | 'bool' | 'bytes';
export interface EvmArgDescriptor {
    /** The name a policy condition reaches this argument by. */
    readonly name: string;
    readonly type: EvmArgType;
}
export interface EvmFunctionDescriptor {
    readonly name: string;
    /** `0x` + 8 hex. */
    readonly selector: string;
    readonly args: readonly EvmArgDescriptor[];
}
export type EvmDecodeFailureCode = 
/** No descriptor for this 4-byte selector. We cannot say what the call does. */
'authority-action-unknown-selector'
/** A descriptor matched but the bytes do not decode against it. */
 | 'authority-action-undecodable'
/** `execute(dest, value, "")`. A definite refusal, not an integration fault. */
 | 'authority-deny-bare-value-transfer';
export interface EvmDecodeFailure {
    readonly kind: 'failed';
    readonly code: EvmDecodeFailureCode;
    readonly reason: string;
}
export interface EvmDecodedCall {
    readonly kind: 'decoded';
    readonly selector: string;
    readonly functionName: string;
    readonly args: Readonly<Record<string, AuthorityFieldValue>>;
}
/**
 * `approve(address,uint256)` — published selector. *Not computed here* (no
 * keccak in this package); assert with `viem`'s `toFunctionSelector` in a
 * consumer that has it.
 */
export declare const ERC20_APPROVE: EvmFunctionDescriptor;
/** `transfer(address,uint256)` — published selector, same caveat. */
export declare const ERC20_TRANSFER: EvmFunctionDescriptor;
/**
 * `execute(address,uint256,bytes)` — the ERC-4337 account wrapper a
 * UserOperation's `callData` normally is. Published selector, same caveat.
 */
export declare const ACCOUNT_EXECUTE: EvmFunctionDescriptor;
/**
 * Selectors treated as an account-level execute wrapper, to be unwrapped to the
 * inner call before the policy sees it.
 *
 * Batch wrappers are absent on purpose. They are not listed as unsupported —
 * they are simply not decodable here, so they land on
 * `authority-action-unknown-selector`, which is the honest answer: an
 * `executeBatch` is an arbitrary `(target, value, data)` list and we cannot say
 * what it does without array-index paths, which `DG-3` records as unavailable.
 */
export declare const ACCOUNT_EXECUTE_SELECTORS: readonly string[];
/**
 * Decodes one call against a descriptor table.
 *
 * The descriptor table *is* the allowlist of shapes we are willing to reason
 * about — an unlisted selector is refused rather than guessed at, which is the
 * same allowlist discipline the policy itself uses.
 */
export declare function decodeEvmCalldata(calldata: string, descriptors: readonly EvmFunctionDescriptor[]): EvmDecodedCall | EvmDecodeFailure;
export interface EvmUserOperationCallInput {
    readonly chainId: number;
    /** The smart account. Target of record when `callData` is not an execute wrapper. */
    readonly sender: string;
    /** `UserOperation.callData`, verbatim. */
    readonly callData: string;
}
export type EvmUserOperationDescription = {
    readonly kind: 'action';
    readonly action: AuthorityContractCall;
} | EvmDecodeFailure;
/**
 * Turns a UserOperation's `callData` into the single `AuthorityContractCall` the
 * policy judges.
 *
 * One level of `execute` unwrapping, never recursive. A nested
 * `execute(execute(...))` therefore surfaces as a call to `execute` *on the
 * account itself*, which no sane scope permits, so it lands on
 * `authority-deny-no-matching-rule` — obfuscation gets no special case, it gets
 * the default.
 */
export declare function describeUserOperationCall(input: EvmUserOperationCallInput, descriptors: readonly EvmFunctionDescriptor[]): EvmUserOperationDescription;
//# sourceMappingURL=evm-calldata.d.ts.map