import { describe, it, expect } from 'vitest';
import {
  ACCOUNT_EXECUTE,
  ERC20_APPROVE,
  ERC20_TRANSFER,
  decodeEvmCalldata,
  describeUserOperationCall,
  type EvmFunctionDescriptor
} from './evm-calldata.js';

const DESCRIPTORS: readonly EvmFunctionDescriptor[] = [
  ERC20_APPROVE,
  ERC20_TRANSFER,
  ACCOUNT_EXECUTE
];

const TOKEN = '0x1111111111111111111111111111111111111111';
const ACCOUNT = '0x5555555555555555555555555555555555555555';

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

describe('decodeEvmCalldata (S4-P10)', () => {
  it('decodes a hand-written approve calldata literal', () => {
    // Written out by hand rather than produced by the helper above, so this test
    // is not just asserting that the encoder and decoder are inverses.
    const calldata =
      '0x095ea7b3' +
      '000000000000000000000000' +
      '1111111111111111111111111111111111111111' +
      '00000000000000000000000000000000000000000000000000000000000003e8';

    const decoded = decodeEvmCalldata(calldata, DESCRIPTORS);
    expect(decoded.kind).toBe('decoded');
    if (decoded.kind !== 'decoded') return;
    expect(decoded.functionName).toBe('approve');
    expect(decoded.selector).toBe('0x095ea7b3');
    expect(decoded.args.spender).toBe(TOKEN);
    expect(decoded.args.amount).toBe(1000n);
  });

  it('refuses an unknown selector under its own code rather than guessing', () => {
    const result = decodeEvmCalldata(`0xdeadbeef${uintWord(1n)}`, DESCRIPTORS);
    expect(result).toMatchObject({ kind: 'failed', code: 'authority-action-unknown-selector' });
  });

  it('refuses calldata shorter than its declared head', () => {
    const result = decodeEvmCalldata(`${ERC20_APPROVE.selector}${addressWord(TOKEN)}`, DESCRIPTORS);
    expect(result).toMatchObject({ kind: 'failed', code: 'authority-action-undecodable' });
  });

  it('refuses an address word with dirty high-order bytes instead of masking it', () => {
    const dirty = `ff${'0'.repeat(22)}${TOKEN.slice(2)}`;
    const result = decodeEvmCalldata(
      `${ERC20_APPROVE.selector}${dirty}${uintWord(1n)}`,
      DESCRIPTORS
    );
    expect(result).toMatchObject({ kind: 'failed', code: 'authority-action-undecodable' });
  });

  it('refuses a non-canonical dynamic tail offset', () => {
    const forged = `${ACCOUNT_EXECUTE.selector}${addressWord(TOKEN)}${uintWord(0n)}${uintWord(
      128n
    )}${uintWord(0n)}${uintWord(4n)}`;
    const result = decodeEvmCalldata(forged, DESCRIPTORS);
    expect(result).toMatchObject({ kind: 'failed', code: 'authority-action-undecodable' });
  });

  it('refuses hex that is not whole bytes', () => {
    const result = decodeEvmCalldata('0x095ea7b', DESCRIPTORS);
    expect(result).toMatchObject({ kind: 'failed', code: 'authority-action-undecodable' });
  });
});

describe('describeUserOperationCall (S4-P10)', () => {
  it('unwraps one level of execute to the inner call', () => {
    const described = describeUserOperationCall(
      { chainId: 4663, sender: ACCOUNT, callData: encodeExecute(TOKEN, 0n, encodeApprove(TOKEN, 5n)) },
      DESCRIPTORS
    );
    expect(described.kind).toBe('action');
    if (described.kind !== 'action') return;
    expect(described.action.target).toBe(TOKEN);
    expect(described.action.functionName).toBe('approve');
    expect(described.action.value).toBe(0n);
    expect(described.action.args.amount).toBe(5n);
  });

  it('carries the execute value through to the action so the policy can bound it', () => {
    const described = describeUserOperationCall(
      { chainId: 4663, sender: ACCOUNT, callData: encodeExecute(TOKEN, 7n, encodeApprove(TOKEN, 5n)) },
      DESCRIPTORS
    );
    if (described.kind !== 'action') throw new Error('expected an action');
    expect(described.action.value).toBe(7n);
  });

  it('refuses a bare value transfer with a definite deny code, not an integration fault', () => {
    const described = describeUserOperationCall(
      { chainId: 4663, sender: ACCOUNT, callData: encodeExecute(TOKEN, 1n, '0x') },
      DESCRIPTORS
    );
    expect(described).toMatchObject({
      kind: 'failed',
      code: 'authority-deny-bare-value-transfer'
    });
  });

  it('treats a non-wrapper outer call as a call on the account itself', () => {
    const described = describeUserOperationCall(
      { chainId: 4663, sender: ACCOUNT, callData: encodeApprove(TOKEN, 1n) },
      DESCRIPTORS
    );
    if (described.kind !== 'action') throw new Error('expected an action');
    expect(described.action.target).toBe(ACCOUNT);
    expect(described.action.functionName).toBe('approve');
  });
});
