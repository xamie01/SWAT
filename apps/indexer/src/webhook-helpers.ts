import crypto from 'node:crypto';
import type { HeliusParsedTransaction } from './parse.js';

export type EnhancedTokenBalanceChange = {
  userAccount?: string;
  mint?: string;
  rawTokenAmount?: {
    tokenAmount?: string;
  };
};

export type EnhancedAccountData = {
  account?: string;
  nativeBalanceChange?: number;
  tokenBalanceChanges?: EnhancedTokenBalanceChange[];
};

export type EnhancedNativeTransfer = {
  fromUserAccount?: string;
  toUserAccount?: string;
  amount?: number;
};

export type EnhancedWebhookEvent = {
  type?: string;
  feePayer?: string;
  signature?: string;
  slot?: number;
  timestamp?: number;
  fee?: number;
  accountData?: EnhancedAccountData[];
  nativeTransfers?: EnhancedNativeTransfer[];
};

export function verifyStaticAuthorization(
  authHeader: string | undefined,
  configuredHeader: string | undefined
): boolean {
  if (!authHeader || !configuredHeader) return false;
  const expected = crypto.createHash('sha256').update(configuredHeader).digest();
  const actual = crypto.createHash('sha256').update(authHeader).digest();
  return crypto.timingSafeEqual(actual, expected);
}

export function isRawHeliusTransaction(value: unknown): value is HeliusParsedTransaction {
  const event = value as HeliusParsedTransaction | null;
  return Boolean(
    event &&
    event.transaction?.signatures?.[0] &&
    event.meta &&
    event.transaction.message
  );
}

export function getEnhancedWalletCandidates(event: EnhancedWebhookEvent): string[] {
  const candidates = new Set<string>();
  if (event.feePayer) candidates.add(event.feePayer);

  for (const account of event.accountData ?? []) {
    if (account.account) candidates.add(account.account);
    for (const change of account.tokenBalanceChanges ?? []) {
      if (change.userAccount) candidates.add(change.userAccount);
    }
  }

  for (const transfer of event.nativeTransfers ?? []) {
    if (transfer.fromUserAccount) candidates.add(transfer.fromUserAccount);
    if (transfer.toUserAccount) candidates.add(transfer.toUserAccount);
  }

  return [...candidates];
}

export function enhancedEventToTransaction(
  event: EnhancedWebhookEvent,
  walletAddress: string
): HeliusParsedTransaction {
  const deltas = new Map<string, bigint>();
  for (const account of event.accountData ?? []) {
    for (const change of account.tokenBalanceChanges ?? []) {
      if (change.userAccount !== walletAddress || !change.mint) continue;
      const amount = BigInt(change.rawTokenAmount?.tokenAmount ?? '0');
      deltas.set(change.mint, (deltas.get(change.mint) ?? 0n) + amount);
    }
  }

  const preTokenBalances = [];
  const postTokenBalances = [];
  for (const [mint, delta] of deltas) {
    preTokenBalances.push({
      owner: walletAddress,
      mint,
      uiTokenAmount: { amount: delta < 0n ? (-delta).toString() : '0' }
    });
    postTokenBalances.push({
      owner: walletAddress,
      mint,
      uiTokenAmount: { amount: delta > 0n ? delta.toString() : '0' }
    });
  }

  const nativeChange = (event.accountData ?? [])
    .find((account) => account.account === walletAddress)
    ?.nativeBalanceChange ?? 0;
  const nativeMagnitude = Math.abs(nativeChange);

  return {
    slot: event.slot,
    blockTime: event.timestamp,
    transaction: {
      signatures: event.signature ? [event.signature] : [],
      message: {
        accountKeys: [walletAddress],
        instructions: (event.nativeTransfers ?? []).map((transfer) => ({
          program: 'system',
          parsed: {
            type: 'transfer',
            info: {
              source: transfer.fromUserAccount,
              destination: transfer.toUserAccount,
              lamports: transfer.amount
            }
          }
        }))
      }
    },
    meta: {
      fee: event.fee ?? 0,
      preBalances: [nativeChange < 0 ? nativeMagnitude : 0],
      postBalances: [nativeChange > 0 ? nativeMagnitude : 0],
      preTokenBalances,
      postTokenBalances
    }
  };
}
