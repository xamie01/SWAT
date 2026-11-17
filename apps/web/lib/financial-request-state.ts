import { ApiError } from './api.js';
import type { FinancialResponse, WithdrawalAuthorization } from './domain-transport.js';

export type RequestPhase = 'editable' | 'dispatching' | 'unknown' | 'awaiting-authorization' | 'pending' | 'terminal' | 'refused';
export interface ImmutableOperation {
  readonly key: string;
  readonly kind: 'withdrawal' | 'reducing';
  readonly positionId?: string;
  readonly venue?: 'spot' | 'polymarket-perps';
  readonly request: Readonly<Record<string, string | number>>;
}
export interface RequestState {
  readonly phase: RequestPhase;
  readonly operation: ImmutableOperation | null;
  readonly recordId: string | null;
  /** A previous admission may have committed; a later validation refusal cannot erase it. */
  readonly admissionUnknown: boolean;
  readonly confirmationUnknown: boolean;
  readonly authorization: { intentId: string; authorizationId: string } | null;
  readonly outcome: FinancialResponse | null;
}
export const emptyRequestState = (): RequestState => ({ phase: 'editable', operation: null, recordId: null,
  admissionUnknown: false, confirmationUnknown: false, authorization: null, outcome: null });
export const requestEditable = (state: RequestState): boolean => state.phase === 'editable' || state.phase === 'refused';
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
/** Storage is explicitly injected. A failed write prevents dispatch; OTP is never persisted. */
export function createRequestMachine(persist: (state: RequestState) => void, initial: RequestState = emptyRequestState()) {
  let state = copy(initial);
  // Reload while dispatching is an unknown committed outcome, never an editable draft.
  if (state.phase === 'dispatching' || (state.operation && !state.recordId && state.phase === 'unknown')) {
    state = { ...state, phase: 'unknown', admissionUnknown: state.admissionUnknown === true || !state.recordId };
  } else if (state.admissionUnknown === undefined) {
    state = { ...state, admissionUnknown: false };
  }
  function save(next: RequestState) { persist(copy(next)); state = next; return copy(state); }
  return {
    state: () => copy(state),
    beginAdmission(operation: ImmutableOperation) {
      if (!requestEditable(state)) throw new Error('Unresolved immutable operation');
      const snapshot = copy(operation);
      if (!snapshot.key || snapshot.request.requestKey !== snapshot.key) throw new Error('Missing immutable request key');
      return save({ ...emptyRequestState(), operation: snapshot, phase: 'dispatching' });
    },
    retryAdmission() {
      if (!state.operation || state.confirmationUnknown || state.recordId || !['unknown', 'dispatching'].includes(state.phase)) throw new Error('Reconcile recorded intent instead');
      save({ ...state, phase: 'dispatching', admissionUnknown: true }); return copy(state.operation!);
    },
    beginConfirmation() {
      if (!state.authorization || !['awaiting-authorization', 'unknown'].includes(state.phase)) throw new Error('No recorded authorization');
      return save({ ...state, phase: 'dispatching', confirmationUnknown: true });
    },
    unknown() { if (!state.operation) throw new Error('No dispatched intent'); return save({ ...state, phase: 'unknown',
      admissionUnknown: state.admissionUnknown || !state.recordId }); },
    /** Only explicit validation before admission proves no effect. Other failures remain fenced. */
    admissionError(error: unknown) {
      const code = error instanceof ApiError ? (error.body as { code?: unknown } | null)?.code : null;
      const definite = error instanceof ApiError && error.status === 400 && ['INVALID_EXACT_WITHDRAWAL', 'INVALID_EXACT_REDUCTION'].includes(String(code));
      const refused = definite && !state.admissionUnknown && !state.recordId && !state.confirmationUnknown;
      return save({ ...state, phase: refused ? 'refused' : 'unknown',
        admissionUnknown: state.admissionUnknown || (!refused && !state.recordId) });
    },
    observe(response: FinancialResponse) {
      const record = response?.record;
      if (!state.operation || !record || record.intent?.requestKey !== state.operation.key || record.intent.kind !== state.operation.kind
        || Object.entries(state.operation.request).some(([key, value]) => record.intent[key] !== value)
        || (state.operation.kind === 'reducing' && (record.intent.positionId !== state.operation.positionId || record.intent.venue !== state.operation.venue))
        || (state.recordId !== null && record.id !== state.recordId) || typeof record.terminal !== 'boolean'
        || !['awaiting-authorization', 'queued', 'prepared', 'uncertain', 'partial', 'settled', 'failed', 'cancelled'].includes(record.status)) {
        save({ ...state, phase: 'unknown', admissionUnknown: state.admissionUnknown || !state.recordId }); throw new Error('Unverified immutable outcome');
      }
      const maximum = record.intent.kind === 'withdrawal' ? record.intent.amountRaw : record.intent.quantityRaw;
      if (typeof maximum !== 'string' || !/^(0|[1-9][0-9]*)$/.test(maximum) || !/^(0|[1-9][0-9]*)$/.test(record.completedRaw)
        || BigInt(record.completedRaw) > BigInt(maximum) || (record.status === 'settled' && (!record.terminal || record.completedRaw !== maximum))) {
        save({ ...state, phase: 'unknown', admissionUnknown: state.admissionUnknown || !state.recordId }); throw new Error('Contradictory settlement outcome');
      }
      const terminal = record.terminal && ['partial', 'settled', 'failed', 'cancelled'].includes(record.status);
      const awaiting = record.status === 'awaiting-authorization' && !record.terminal;
      const auth = response as Partial<WithdrawalAuthorization>;
      const authorization = awaiting && auth.delivery === 'sent' && typeof auth.authorizationId === 'string'
        ? { intentId: record.id, authorizationId: auth.authorizationId } : state.authorization;
      return save({ ...state, recordId: record.id, outcome: copy(response), authorization,
        confirmationUnknown: false, phase: terminal ? 'terminal' : awaiting ? 'awaiting-authorization' : 'pending' });
    },
    startFresh() {
      if (state.phase !== 'terminal' && state.phase !== 'refused') throw new Error('Unresolved effect cannot be replaced');
      return save(emptyRequestState());
    }
  };
}
export type RequestMachine = ReturnType<typeof createRequestMachine>;
