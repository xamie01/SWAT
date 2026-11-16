import { describe, expect, it } from 'vitest';
import { compileAuthorityPolicy, evaluateAuthorityAction } from './permission-policy.js';
import { ERC20_APPROVE, decodeEvmCalldata } from './evm-calldata.js';
const token = '0x1111111111111111111111111111111111111111';
const owner = '0x2222222222222222222222222222222222222222';
const spender = '0x3333333333333333333333333333333333333333';
const approve = { id: 'approve', scope: { kind: 'contract-call', targets: [token], selector: ERC20_APPROVE.selector, functionName: 'approve' }, conditions: [
  { field: 'approve.spender', op: 'address_in', addresses: [spender] }, { field: 'approve.amount', op: 'uint_lte', max: '100' }
] };
const compile = (rule: unknown) => compileAuthorityPolicy({ version: 1, chainId: 137, rules: [rule] });
const calldata = ERC20_APPROVE.selector + spender.slice(2).padStart(64, '0') + '1'.padStart(64, '0');
describe('package21 semantic ABI authority', () => {
  it('cannot alias the approval selector to evade semantic spender/amount checks', () => {
    expect(() => compile({ ...approve, scope: { ...approve.scope, functionName: 'harmless' }, conditions: [] })).toThrow();
  });
  it('cannot replace a trusted selector ABI with a renamed/reordered descriptor', () => {
    expect(decodeEvmCalldata(calldata, [{ ...ERC20_APPROVE, name: 'harmless', args: [{ name: 'amount', type: 'address' }, { name: 'spender', type: 'uint256' }] }])).toMatchObject({ kind: 'failed' });
  });
  it('rejects ambiguous duplicate descriptor selectors instead of first-match decoding', () => {
    expect(decodeEvmCalldata(calldata, [ERC20_APPROVE, { ...ERC20_APPROVE }])).toMatchObject({ kind: 'failed' });
  });
  it('token and nonce conditions do not constrain Permit spender and amount', () => {
    expect(() => compile({ id: 'permit', scope: { kind: 'signed-struct', verifyingContracts: [token], primaryType: 'Permit' }, conditions: [
      { field: 'message.token', op: 'address_in', addresses: [token] }, { field: 'message.nonce', op: 'uint_lte', max: '100' }
    ] })).toThrow();
  });
  it.each(['PermitBatch', 'PermitWitnessTransferFrom', 'unregistered'])('refuses unsupported signed type %s', primaryType => {
    expect(() => compile({ id: 'unsupported', scope: { kind: 'signed-struct', verifyingContracts: [token], primaryType }, conditions: [] })).toThrow();
  });
  it('refuses unregistered swap schemas instead of accepting missing recipient/minimum economics', () => {
    expect(() => compile({ id: 'swap', scope: { kind: 'contract-call', targets: [token], selector: '0x12345678', functionName: 'swap' }, conditions: [] })).toThrow();
  });
  it('checks selector/name binding again on final decoded actions', () => {
    const verdict = evaluateAuthorityAction(compile(approve), { kind: 'contract-call', chainId: 137, target: token, selector: ERC20_APPROVE.selector, functionName: 'harmless', value: 0n, args: { spender, amount: 1n } }, { ownerAccount: owner, nowSeconds: 100 });
    expect(verdict.kind).not.toBe('permit');
  });
  it('rejects negative unsigned payloads and nonfinite authorization clocks', () => {
    const action = { kind: 'contract-call' as const, chainId: 137, target: token, selector: ERC20_APPROVE.selector, functionName: 'approve', value: 0n, args: { spender, amount: -1n } };
    expect(evaluateAuthorityAction(compile(approve), action, { ownerAccount: owner, nowSeconds: 100 }).kind).not.toBe('permit');
    expect(evaluateAuthorityAction(compile(approve), { ...action, args: { spender, amount: 1n } }, { ownerAccount: owner, nowSeconds: NaN }).kind).not.toBe('permit');
  });
  it('refuses trailing static calldata ignored by a partial decoder', () => {
    expect(decodeEvmCalldata(calldata + '00', [ERC20_APPROVE])).toMatchObject({ kind: 'failed' });
  });
});
