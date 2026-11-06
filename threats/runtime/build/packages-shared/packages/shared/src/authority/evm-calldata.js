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
/**
 * `approve(address,uint256)` — published selector. *Not computed here* (no
 * keccak in this package); assert with `viem`'s `toFunctionSelector` in a
 * consumer that has it.
 */
export const ERC20_APPROVE = {
    name: 'approve',
    selector: '0x095ea7b3',
    args: [
        { name: 'spender', type: 'address' },
        { name: 'amount', type: 'uint256' }
    ]
};
/** `transfer(address,uint256)` — published selector, same caveat. */
export const ERC20_TRANSFER = {
    name: 'transfer',
    selector: '0xa9059cbb',
    args: [
        { name: 'to', type: 'address' },
        { name: 'amount', type: 'uint256' }
    ]
};
/**
 * `execute(address,uint256,bytes)` — the ERC-4337 account wrapper a
 * UserOperation's `callData` normally is. Published selector, same caveat.
 */
export const ACCOUNT_EXECUTE = {
    name: 'execute',
    selector: '0xb61d27f6',
    args: [
        { name: 'dest', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'func', type: 'bytes' }
    ]
};
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
export const ACCOUNT_EXECUTE_SELECTORS = [ACCOUNT_EXECUTE.selector];
const WORD_HEX = 64;
function failed(code, reason) {
    return { kind: 'failed', code, reason };
}
/** Strips `0x`, lowercases, and rejects anything that is not whole bytes of hex. */
function normalizeHex(value) {
    if (typeof value !== 'string')
        return null;
    const body = value.startsWith('0x') || value.startsWith('0X') ? value.slice(2) : value;
    if (body.length % 2 !== 0)
        return null;
    if (body.length > 0 && !/^[0-9a-fA-F]+$/.test(body))
        return null;
    return body.toLowerCase();
}
function readWord(body, wordIndex) {
    const start = wordIndex * WORD_HEX;
    if (start + WORD_HEX > body.length)
        return null;
    return body.slice(start, start + WORD_HEX);
}
function validateDescriptor(descriptor) {
    for (let i = 0; i < descriptor.args.length; i += 1) {
        const arg = descriptor.args[i];
        if (arg.type === 'bytes' && i !== descriptor.args.length - 1) {
            return `descriptor ${descriptor.name} declares a bytes argument that is not last; this decoder supports one dynamic tail only`;
        }
    }
    return null;
}
/**
 * Decodes one call against a descriptor table.
 *
 * The descriptor table *is* the allowlist of shapes we are willing to reason
 * about — an unlisted selector is refused rather than guessed at, which is the
 * same allowlist discipline the policy itself uses.
 */
export function decodeEvmCalldata(calldata, descriptors) {
    const body = normalizeHex(calldata);
    if (body === null) {
        return failed('authority-action-undecodable', 'calldata is not an even-length hex string');
    }
    if (body.length < 8) {
        return failed('authority-action-undecodable', `calldata is ${body.length / 2} bytes, too short to carry a 4-byte selector`);
    }
    const selector = `0x${body.slice(0, 8)}`;
    const descriptor = descriptors.find((d) => d.selector.toLowerCase() === selector);
    if (descriptor === undefined) {
        return failed('authority-action-unknown-selector', `no descriptor for selector ${selector}; this engine will not authorise a call it cannot decode`);
    }
    const descriptorProblem = validateDescriptor(descriptor);
    if (descriptorProblem !== null) {
        return failed('authority-action-undecodable', descriptorProblem);
    }
    const argsBody = body.slice(8);
    const headWords = descriptor.args.length;
    if (argsBody.length < headWords * WORD_HEX) {
        return failed('authority-action-undecodable', `call to ${descriptor.name} carries ${argsBody.length / 2} argument bytes, fewer than the ${headWords * 32} its head requires`);
    }
    const args = {};
    for (let i = 0; i < descriptor.args.length; i += 1) {
        const arg = descriptor.args[i];
        const word = readWord(argsBody, i);
        if (word === null) {
            return failed('authority-action-undecodable', `argument ${arg.name} is truncated`);
        }
        if (arg.type === 'address') {
            // Reject dirty high-order bits rather than masking them: masking makes the
            // policy check a value the EVM will not necessarily use.
            if (word.slice(0, 24) !== '0'.repeat(24)) {
                return failed('authority-action-undecodable', `argument ${arg.name} is not a clean address word (non-zero high-order bytes)`);
            }
            args[arg.name] = `0x${word.slice(24)}`;
            continue;
        }
        if (arg.type === 'uint256') {
            args[arg.name] = BigInt(`0x${word}`);
            continue;
        }
        if (arg.type === 'bool') {
            const asInt = BigInt(`0x${word}`);
            if (asInt !== 0n && asInt !== 1n) {
                return failed('authority-action-undecodable', `argument ${arg.name} is not a canonical bool word (${asInt})`);
            }
            args[arg.name] = asInt === 1n;
            continue;
        }
        // `bytes`, the single dynamic tail.
        const offset = BigInt(`0x${word}`);
        const expectedOffset = BigInt(headWords * 32);
        if (offset !== expectedOffset) {
            // A non-canonical offset is how the same bytes decode two different ways in
            // two different decoders. Refuse rather than follow it.
            return failed('authority-action-undecodable', `argument ${arg.name} has a non-canonical tail offset ${offset}, expected ${expectedOffset}`);
        }
        const lengthWord = readWord(argsBody, headWords);
        if (lengthWord === null) {
            return failed('authority-action-undecodable', `argument ${arg.name} has no length word`);
        }
        const byteLength = BigInt(`0x${lengthWord}`);
        if (byteLength > BigInt(argsBody.length)) {
            return failed('authority-action-undecodable', `argument ${arg.name} declares ${byteLength} bytes, more than the calldata holds`);
        }
        const dataStart = (headWords + 1) * WORD_HEX;
        const dataHexLength = Number(byteLength) * 2;
        if (dataStart + dataHexLength > argsBody.length) {
            return failed('authority-action-undecodable', `argument ${arg.name} declares ${byteLength} bytes but only ${(argsBody.length - dataStart) / 2} remain`);
        }
        args[arg.name] = `0x${argsBody.slice(dataStart, dataStart + dataHexLength)}`;
    }
    return { kind: 'decoded', selector, functionName: descriptor.name, args };
}
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
export function describeUserOperationCall(input, descriptors) {
    const outer = decodeEvmCalldata(input.callData, descriptors);
    if (outer.kind === 'failed')
        return outer;
    if (!ACCOUNT_EXECUTE_SELECTORS.includes(outer.selector)) {
        // Not a wrapper: the UserOperation calls a function on the account itself.
        return {
            kind: 'action',
            action: {
                kind: 'contract-call',
                chainId: input.chainId,
                target: input.sender,
                selector: outer.selector,
                functionName: outer.functionName,
                value: 0n,
                args: outer.args
            }
        };
    }
    const dest = outer.args.dest;
    const value = outer.args.value;
    const func = outer.args.func;
    if (typeof dest !== 'string' || typeof value !== 'bigint' || typeof func !== 'string') {
        return failed('authority-action-undecodable', 'execute wrapper did not decode to (address dest, uint256 value, bytes func)');
    }
    const innerBody = normalizeHex(func);
    if (innerBody === null || innerBody.length === 0) {
        return failed('authority-deny-bare-value-transfer', `execute(${dest}, ${value}, "") is a bare native transfer; this engine never authorises one`);
    }
    const inner = decodeEvmCalldata(func, descriptors);
    if (inner.kind === 'failed')
        return inner;
    return {
        kind: 'action',
        action: {
            kind: 'contract-call',
            chainId: input.chainId,
            target: dest,
            selector: inner.selector,
            functionName: inner.functionName,
            value,
            args: inner.args
        }
    };
}
//# sourceMappingURL=evm-calldata.js.map