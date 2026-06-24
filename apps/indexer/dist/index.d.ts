import { type HeliusParsedTransaction } from './parse.js';
export declare function ingestWallets(input: Array<{
    address: string;
    source?: 'shiller' | 'manual' | 'discovered';
    nickname?: string;
}>): Promise<{
    accepted: number;
    rejected: number;
}>;
export declare function processTransaction(tx: HeliusParsedTransaction, address: string): Promise<'inserted' | 'skipped'>;
/**
 * Discover and seed a token's early & biggest buyers from on-chain history.
 *
 * 1. Page `getSignaturesForAddress(mint)` back to the launch (bounded by a safety
 *    cap), reverse to chronological order, take the first `TOKEN_DISCOVERY_WINDOW`
 *    signatures from launch forward.
 * 2. Fetch those txs, and for each gather the accounts that net-gained the mint
 *    (`extractTokenBuyers`). Aggregate per owner: earliest buy time + total base
 *    units acquired.
 * 3. Take the 40 EARLIEST distinct buyers (`token-early`, kept unconditionally)
 *    and, from the rest, the 10 LARGEST by acquired amount (`token-big`,
 *    profit-gated later). Upsert each and enqueue a normal history backfill so the
 *    scorer can score/cluster them like any other wallet.
 */
export declare function discoverFromToken(mint: string): Promise<{
    earlyBuyers: number;
    bigBuyers: number;
    scanned: number;
}>;
//# sourceMappingURL=index.d.ts.map