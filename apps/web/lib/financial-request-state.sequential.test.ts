import { expect, it } from 'vitest';
import { ApiError } from './api.js';
import { createRequestMachine, requestEditable, type ImmutableOperation, type RequestState } from './financial-request-state.js';
import type { FinancialResponse } from './domain-transport.js';
const operation: ImmutableOperation = { key: 'key-1', kind: 'reducing', positionId: 'position-1', venue: 'spot',
  request: { requestKey: 'key-1', quantityRaw: '900719925474099312345678', network: 'genesis', maxFeeRaw: '0' } };
const response = (status: string, terminal = false): FinancialResponse => ({ capability: {}, record: {
  id: 'intent-1', intentHash: 'hash', status, terminal, completedRaw: status === 'settled' ? '900719925474099312345678' : '40',
  intent: { ...operation.request, kind: 'reducing', positionId: 'position-1', venue: 'spot', mode: 'paper', assetScale: 9 }
} } as FinancialResponse);
it('writes immutable intent before dispatch and lost admission response cannot generate a replacement operation', () => {
  const writes: RequestState[] = []; const machine = createRequestMachine(state => writes.push(state));
  machine.beginAdmission(operation); expect(writes[0]!.phase).toBe('dispatching');
  machine.unknown(); expect(requestEditable(machine.state())).toBe(false);
  expect(() => machine.beginAdmission({ ...operation, key: 'replacement' })).toThrow();
  expect(machine.retryAdmission()).toEqual(operation);
  const restarted = createRequestMachine(state => writes.push(state), machine.state());
  expect(restarted.state().phase).toBe('unknown'); expect(restarted.retryAdmission().request.quantityRaw).toBe(operation.request.quantityRaw);
});
it('failed fence persistence prevents sending any operation', () => {
  const machine = createRequestMachine(() => { throw new Error('storage unavailable'); });
  expect(() => machine.beginAdmission(operation)).toThrow(); expect(machine.state().phase).toBe('editable');
});
it('snapshot does not mutate when editable inputs change after dispatch', () => {
  const machine = createRequestMachine(() => {}); const draft = { ...operation, request: { ...operation.request } };
  machine.beginAdmission(draft); draft.request.quantityRaw = '1'; machine.unknown();
  expect(machine.retryAdmission().request.quantityRaw).toBe('900719925474099312345678');
});
it('explicit pre-admission validation refusal differs from timeout/5xx/unknown denial', () => {
  for (const error of [new Error('lost response'), new ApiError(503, 'unknown'), new ApiError(409, 'conflict'), new ApiError(400, 'unknown', {})]) {
    const machine = createRequestMachine(() => {}); machine.beginAdmission(operation); machine.admissionError(error);
    expect(machine.state().phase).toBe('unknown'); expect(requestEditable(machine.state())).toBe(false);
  }
  const machine = createRequestMachine(() => {}); machine.beginAdmission(operation);
  machine.admissionError(new ApiError(400, 'validation', { code: 'INVALID_EXACT_REDUCTION' }));
  expect(requestEditable(machine.state())).toBe(true);
});
it.each(['reducing', 'withdrawal'] as const)('earlier unknown %s admission survives reload and a later retry validation refusal', kind => {
  const code = kind === 'reducing' ? 'INVALID_EXACT_REDUCTION' : 'INVALID_EXACT_WITHDRAWAL';
  const submitted = { ...operation, kind };
  const machine = createRequestMachine(() => {}); machine.beginAdmission(submitted); machine.unknown();
  const restarted = createRequestMachine(() => {}, machine.state()); restarted.retryAdmission();
  restarted.admissionError(new ApiError(400, 'new schema validation', { code }));
  expect(restarted.state().admissionUnknown).toBe(true); expect(restarted.state().phase).toBe('unknown');
  expect(requestEditable(restarted.state())).toBe(false); expect(() => restarted.startFresh()).toThrow();
  expect(() => restarted.beginAdmission({ ...submitted, key: 'replacement' })).toThrow();
  const again = createRequestMachine(() => {}, restarted.state()); expect(again.retryAdmission()).toEqual(submitted);
  again.admissionError(new ApiError(400, 'still refused', { code })); expect(requestEditable(again.state())).toBe(false);
});
it('old persisted dispatch without an ambiguity field is conservatively fenced after reload', () => {
  const machine = createRequestMachine(() => {}); machine.beginAdmission(operation);
  const legacy = { ...machine.state() } as Partial<RequestState>; delete legacy.admissionUnknown;
  const restarted = createRequestMachine(() => {}, legacy as RequestState); restarted.retryAdmission();
  restarted.admissionError(new ApiError(400, 'validation', { code: 'INVALID_EXACT_REDUCTION' }));
  expect(requestEditable(restarted.state())).toBe(false); expect(restarted.state().admissionUnknown).toBe(true);
});
it('lost withdrawal confirmation response retains original authorization/intent and requires status reconciliation', () => {
  const machine = createRequestMachine(() => {});
  const withdrawal: ImmutableOperation = { key: 'key-1', kind: 'withdrawal', request: { requestKey: 'key-1', amountRaw: '100' } };
  machine.beginAdmission(withdrawal);
  machine.observe({ record: { id: 'intent-1', intent: { kind: 'withdrawal', requestKey: 'key-1', amountRaw: '100' },
    status: 'awaiting-authorization', terminal: false, completedRaw: '0' }, delivery: 'sent', authorizationId: 'auth-1' } as unknown as FinancialResponse);
  machine.beginConfirmation(); machine.unknown();
  expect(machine.state().authorization).toEqual({ intentId: 'intent-1', authorizationId: 'auth-1' });
  expect(machine.state().recordId).toBe('intent-1'); expect(() => machine.retryAdmission()).toThrow();
  expect(() => machine.startFresh()).toThrow(); expect(JSON.stringify(machine.state())).not.toContain('123456');
});
it('nonterminal partial stays fenced; terminal partial permits only explicit fresh authorization', () => {
  const machine = createRequestMachine(() => {}); machine.beginAdmission(operation);
  machine.observe(response('partial')); expect(machine.state().phase).toBe('pending'); expect(() => machine.startFresh()).toThrow();
  machine.observe(response('partial', true)); expect(machine.state().phase).toBe('terminal'); expect(requestEditable(machine.state())).toBe(false);
  machine.startFresh(); expect(requestEditable(machine.state())).toBe(true);
  machine.beginAdmission({ ...operation, key: 'key-2', request: { ...operation.request, requestKey: 'key-2' } });
  expect(machine.state().operation!.key).toBe('key-2');
});
it('substituted status/quantity cannot release the unknown fence', () => {
  const machine = createRequestMachine(() => {}); machine.beginAdmission(operation);
  const altered = response('settled', true); altered.record.intent.quantityRaw = '1';
  expect(() => machine.observe(altered)).toThrow(); expect(machine.state().phase).toBe('unknown'); expect(() => machine.startFresh()).toThrow();
});
it('audited cancelled and terminal partial are resolved outcomes, not expiry-derived permissions', () => {
  const machine = createRequestMachine(() => {}); machine.beginAdmission(operation);
  machine.observe(response('cancelled', true)); expect(machine.state().phase).toBe('terminal'); machine.startFresh();
  machine.beginAdmission(operation); machine.observe(response('partial', false));
  expect(() => machine.startFresh()).toThrow();
});
it('a persisted uncertain operation never becomes editable merely due to reload or time passing', () => {
  const machine = createRequestMachine(() => {}); machine.beginAdmission(operation); machine.observe(response('uncertain'));
  const restarted = createRequestMachine(() => {}, machine.state()); expect(requestEditable(restarted.state())).toBe(false);
  expect(() => restarted.startFresh()).toThrow();
});
