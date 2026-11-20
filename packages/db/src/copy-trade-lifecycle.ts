import type { PoolClient, QueryResultRow } from 'pg';
import { query } from './client.js';
import { withTransaction } from './transaction.js';
import * as owned from './copy-trade-lifecycle-owned.js';
export * from './copy-trade-lifecycle-owned.js';

// Compatibility reads retain ambient query behavior; all SQL lives in the owned leaf.
const ambientReadClient = {
  async query<T extends QueryResultRow>(sql: string, values?: unknown[]) {
    return { rows: await query<T>(sql, values) };
  }
} as unknown as PoolClient;

export async function recordSourceTradeEvent(input: Parameters<typeof owned.recordSourceTradeEventWithClient>[1]): ReturnType<typeof owned.recordSourceTradeEventWithClient> {
  return withTransaction(owned.prepareRecordSourceTradeEvent(input));
}

export async function verifySourceTrade(input: Parameters<typeof owned.verifySourceTradeWithClient>[1]): ReturnType<typeof owned.verifySourceTradeWithClient> {
  return withTransaction(client => owned.verifySourceTradeWithClient(client, input));
}

export async function getCanonicalSourceTradeById(id: string): ReturnType<typeof owned.getCanonicalSourceTradeByIdWithClient> {
  return owned.getCanonicalSourceTradeByIdWithClient(ambientReadClient, id);
}

export async function getSourceTradeByIdentity(input: Parameters<typeof owned.getSourceTradeByIdentityWithClient>[1]): ReturnType<typeof owned.getSourceTradeByIdentityWithClient> {
  return owned.getSourceTradeByIdentityWithClient(ambientReadClient, input);
}

export async function listSourceTradeSignalCandidates(input: Parameters<typeof owned.listSourceTradeSignalCandidatesWithClient>[1]): ReturnType<typeof owned.listSourceTradeSignalCandidatesWithClient> {
  return withTransaction(owned.prepareListSourceTradeSignalCandidates(input));
}

export async function markSourceTradeSignalDispatched(signalId: string, dispatchedAt = new Date()): ReturnType<typeof owned.markSourceTradeSignalDispatchedWithClient> {
  return owned.markSourceTradeSignalDispatchedWithClient(ambientReadClient, signalId, dispatchedAt);
}

export async function insertSourceTradeSignal(input: Parameters<typeof owned.insertSourceTradeSignalWithClient>[1]): ReturnType<typeof owned.insertSourceTradeSignalWithClient> {
  return withTransaction(owned.prepareInsertSourceTradeSignal(input));
}

export async function requestCopyExecution(input: Parameters<typeof owned.requestCopyExecutionWithClient>[1]): ReturnType<typeof owned.requestCopyExecutionWithClient> {
  return withTransaction(owned.prepareRequestCopyExecution(input));
}

export async function claimLotExitExecution(input: Parameters<typeof owned.claimLotExitExecutionWithClient>[1]): ReturnType<typeof owned.claimLotExitExecutionWithClient> {
  return withTransaction(client => owned.claimLotExitExecutionWithClient(client, input));
}

export async function claimSourceSignalForCopyExecution(input: Parameters<typeof owned.claimSourceSignalForCopyExecutionWithClient>[1]): ReturnType<typeof owned.claimSourceSignalForCopyExecutionWithClient> {
  return withTransaction(client => owned.claimSourceSignalForCopyExecutionWithClient(client, input));
}

export async function transitionCopyExecution(input: Parameters<typeof owned.transitionCopyExecutionWithClient>[1]): ReturnType<typeof owned.transitionCopyExecutionWithClient> {
  return withTransaction(client => owned.transitionCopyExecutionWithClient(client, input));
}

export async function recordCopyExecutionEvidence(input: Parameters<typeof owned.recordCopyExecutionEvidenceWithClient>[1]): ReturnType<typeof owned.recordCopyExecutionEvidenceWithClient> {
  return withTransaction(client => owned.recordCopyExecutionEvidenceWithClient(client, input));
}

export async function getCopyExecutionById(id: string): ReturnType<typeof owned.readCopyExecutionByIdWithClient> {
  return owned.readCopyExecutionByIdWithClient(ambientReadClient, id);
}

export async function getCopyExecutionByClientOrderId(input: Parameters<typeof owned.getCopyExecutionByClientOrderIdWithClient>[1]): ReturnType<typeof owned.getCopyExecutionByClientOrderIdWithClient> {
  return owned.getCopyExecutionByClientOrderIdWithClient(ambientReadClient, input);
}

export async function getCopyExecutionByClientOrderIdentity(input: Parameters<typeof owned.getCopyExecutionByClientOrderIdentityWithClient>[1]): ReturnType<typeof owned.getCopyExecutionByClientOrderIdentityWithClient> {
  return owned.getCopyExecutionByClientOrderIdentityWithClient(ambientReadClient, input);
}

export async function getCopyExecutionBySubmissionIdentity(input: Parameters<typeof owned.getCopyExecutionBySubmissionIdentityWithClient>[1]): ReturnType<typeof owned.getCopyExecutionBySubmissionIdentityWithClient> {
  return owned.getCopyExecutionBySubmissionIdentityWithClient(ambientReadClient, input);
}

export async function claimCopyExecutionsForReconciliation(input: Parameters<typeof owned.claimCopyExecutionsForReconciliationWithClient>[1] = {}): ReturnType<typeof owned.claimCopyExecutionsForReconciliationWithClient> {
  return owned.claimCopyExecutionsForReconciliationWithClient(ambientReadClient, input);
}

export async function releaseCopyExecutionReconciliationClaim(input: Parameters<typeof owned.releaseCopyExecutionReconciliationClaimWithClient>[1]): ReturnType<typeof owned.releaseCopyExecutionReconciliationClaimWithClient> {
  return owned.releaseCopyExecutionReconciliationClaimWithClient(ambientReadClient, input);
}
