export type SignatureRecord = {
  signature: string;
};

export type SignaturePageRequest = {
  before?: string;
  limit: number;
};

export type PaginatedSignatures<T extends SignatureRecord> = {
  signatures: T[];
  reachedOldest: boolean;
  capped: boolean;
};

export function clampInteger(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.trunc(parsed)));
}

export async function collectSignaturesToOldest<T extends SignatureRecord>(
  fetchPage: (request: SignaturePageRequest) => Promise<T[]>,
  options: {
    maxTotal: number;
    pageSize?: number;
  }
): Promise<PaginatedSignatures<T>> {
  const maxTotal = clampInteger(options.maxTotal, 1000, 1, 100_000);
  const pageSize = clampInteger(options.pageSize, 1000, 1, 1000);
  const signatures: T[] = [];
  const seen = new Set<string>();
  let before: string | undefined;
  let reachedOldest = false;

  while (signatures.length < maxTotal) {
    const limit = Math.min(pageSize, maxTotal - signatures.length);
    const page = await fetchPage({ before, limit });
    if (page.length === 0) {
      reachedOldest = true;
      break;
    }

    for (const record of page) {
      if (!seen.has(record.signature)) {
        seen.add(record.signature);
        signatures.push(record);
      }
    }

    if (page.length < limit) {
      reachedOldest = true;
      break;
    }

    const nextBefore = page[page.length - 1]?.signature;
    if (!nextBefore || nextBefore === before) {
      break;
    }
    before = nextBefore;
  }

  // A full final page does not prove that the final record is the account
  // origin. Probe once beyond the cap without retaining more history.
  if (!reachedOldest && signatures.length >= maxTotal && before) {
    const probe = await fetchPage({ before, limit: 1 });
    reachedOldest = probe.length === 0;
  }

  return {
    signatures,
    reachedOldest,
    capped: !reachedOldest && signatures.length >= maxTotal
  };
}

export type StarterPackWalletScore = {
  address: string;
  patterns: string[];
  successfulTrades: number;
  totalTrades: number;
  winRate: number | null;
  score: number;
};

type MutableWalletScore = {
  address: string;
  patterns: Set<string>;
  patternMatches: Set<string>;
  tradeOutcomes: Map<string, boolean>;
};

export function createStarterPackScoreTracker() {
  const wallets = new Map<string, MutableWalletScore>();

  function getWallet(address: string) {
    const existing = wallets.get(address);
    if (existing) return existing;

    const created: MutableWalletScore = {
      address,
      patterns: new Set(),
      patternMatches: new Set(),
      tradeOutcomes: new Map()
    };
    wallets.set(address, created);
    return created;
  }

  function recordPattern(address: string, pattern: string, context: string) {
    const wallet = getWallet(address);
    wallet.patterns.add(pattern);
    wallet.patternMatches.add(`${pattern}:${context}`);
  }

  function recordTradeOutcome(address: string, tradeKey: string, isWin: boolean) {
    const wallet = getWallet(address);
    if (!wallet.tradeOutcomes.has(tradeKey)) {
      wallet.tradeOutcomes.set(tradeKey, isWin);
    }
  }

  function results(): StarterPackWalletScore[] {
    return [...wallets.values()]
      .filter((wallet) => wallet.patternMatches.size > 0)
      .map((wallet) => {
        const outcomes = [...wallet.tradeOutcomes.values()];
        const successfulTrades = outcomes.filter(Boolean).length;
        const totalTrades = outcomes.length;

        return {
          address: wallet.address,
          patterns: [...wallet.patterns],
          successfulTrades,
          totalTrades,
          winRate: totalTrades > 0
            ? Math.round((successfulTrades / totalTrades) * 100)
            : null,
          score: wallet.patternMatches.size
        };
      });
  }

  return {
    recordPattern,
    recordTradeOutcome,
    results
  };
}
