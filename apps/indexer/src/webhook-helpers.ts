import crypto from 'node:crypto';
import { decodeTransferInstruction, type HeliusParsedTransaction, type HeliusParsedInstruction, type HeliusTokenBalance } from './parse.js';

export type EnhancedTokenBalanceChange = {
  userAccount?: string;
  tokenAccount?: string;
  mint?: string;
  rawTokenAmount?: {
    tokenAmount?: string;
    decimals?: number;
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
  transactionError?: unknown;
  instructions?: Array<HeliusParsedInstruction & { innerInstructions?: HeliusParsedInstruction[] }>;
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
  const accountKeys = [...new Set([event.feePayer ?? '', walletAddress,
    ...(event.accountData ?? []).map(account => account.account ?? ''),
    ...(event.accountData ?? []).flatMap(account => (account.tokenBalanceChanges ?? []).map(change => change.tokenAccount ?? ''))
  ])];
  const preTokenBalances: HeliusTokenBalance[] = [];
  const postTokenBalances: HeliusTokenBalance[] = [];
  let malformed = false;
  for (const account of event.accountData ?? []) {
    for (const change of account.tokenBalanceChanges ?? []) {
      if (change.userAccount !== walletAddress) continue;
      const text = change.rawTokenAmount?.tokenAmount;
      if (!change.mint || typeof text !== 'string' || !/^-?(0|[1-9][0-9]{0,19})$/.test(text)) {
        malformed = true;
        continue;
      }
      const delta = BigInt(text);
      const common = {
        owner: walletAddress, mint: change.mint,
        accountIndex: change.tokenAccount ? accountKeys.indexOf(change.tokenAccount) : undefined
      };
      preTokenBalances.push({ ...common, uiTokenAmount: {
        amount: delta < 0n ? (-delta).toString() : '0', decimals: change.rawTokenAmount?.decimals
      } });
      postTokenBalances.push({ ...common, uiTokenAmount: {
        amount: delta > 0n ? delta.toString() : '0', decimals: change.rawTokenAmount?.decimals
      } });
    }
  }
  const balanceChanges = accountKeys.map(key => {
    const value = (event.accountData ?? []).find(account => account.account === key)?.nativeBalanceChange;
    const requiresEvidence = key === walletAddress
      || preTokenBalances.some(balance => accountKeys[balance.accountIndex ?? -1] === key);
    if (requiresEvidence && !Number.isSafeInteger(value)) malformed = true;
    return value ?? 0;
  });

  return {
    slot: event.slot,
    blockTime: event.timestamp,
    transaction: {
      signatures: event.signature ? [event.signature] : [],
      message: {
        accountKeys,
        instructions: [...(event.instructions ?? []), ...(event.nativeTransfers ?? []).map((transfer) => ({
          program: 'system',
          parsed: {
            type: 'transfer',
            info: {
              source: transfer.fromUserAccount,
              destination: transfer.toUserAccount,
              lamports: transfer.amount
            }
          }
        }))]
      }
    },
    meta: {
      err: malformed ? 'Malformed enhanced balance evidence' : event.transactionError,
      fee: event.fee,
      preBalances: balanceChanges.map(value => value < 0 ? -value : 0),
      postBalances: balanceChanges.map(value => value > 0 ? value : 0),
      preTokenBalances,
      postTokenBalances,
      innerInstructions: (event.instructions ?? []).map((ix, index) => ({ index, instructions: (ix.innerInstructions ?? []).map(decodeTransferInstruction) }))
    }
  };
}
