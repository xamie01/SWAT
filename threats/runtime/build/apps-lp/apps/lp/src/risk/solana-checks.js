import { stripChainPrefix } from '@swat/shared';
import { FREEZE_AUTHORITY_FLAG, HOLDER_CONCENTRATION_FLAG, LIQUIDITY_UNLOCKED_FLAG, MINT_AUTHORITY_FLAG } from './types.js';
export async function fetchHolderConcentration(port, mint) {
    const rawMint = stripChainPrefix(mint);
    const [largest, supply] = await Promise.all([
        port.call('getTokenLargestAccounts', [rawMint]),
        port.call('getTokenSupply', [rawMint])
    ]);
    return {
        top10Amounts: largest.value.map((account) => Number(account.amount)),
        supply: Number(supply.value.amount)
    };
}
/**
 * The finding rule for Track C1: the top-10 share of supply. Returns a finding
 * only above `flagThreshold` — a healthy distribution is not a flag.
 */
export function holderConcentrationFinding(snapshot, flagThreshold = 0.5) {
    if (snapshot.supply <= 0)
        return null;
    const top10Share = snapshot.top10Amounts.reduce((sum, amount) => sum + amount, 0) / snapshot.supply;
    if (top10Share < flagThreshold)
        return null;
    return {
        flag: HOLDER_CONCENTRATION_FLAG,
        detail: `top-10 holders own ${(top10Share * 100).toFixed(1)}% of supply`,
        top10Share
    };
}
export function holderConcentrationCheck(port) {
    return async (context) => {
        try {
            const snapshot = await fetchHolderConcentration(port, context.baseTokenMint);
            const finding = holderConcentrationFinding(snapshot);
            return finding ? [finding] : [];
        }
        catch {
            return [];
        }
    };
}
/**
 * Parses an SPL token mint account (82 bytes, base64-encoded by RPC):
 * 0..4 mint-authority COption, 4..36 authority pubkey, 36..44 supply, 44
 * decimals, 45 is-initialized, 46..50 freeze-authority COption, 50..82 freeze
 * pubkey.
 */
export function parseSplMintAuthorities(base64Data) {
    const data = Buffer.from(base64Data, 'base64');
    if (data.length < 82) {
        throw new Error(`mint account data is ${data.length} bytes, expected 82`);
    }
    const mintAuthorityOption = data.readUInt32LE(0);
    const freezeAuthorityOption = data.readUInt32LE(46);
    return {
        mintAuthority: mintAuthorityOption === 0 ? null : data.subarray(4, 36).toString('hex'),
        freezeAuthority: freezeAuthorityOption === 0 ? null : data.subarray(50, 82).toString('hex')
    };
}
export async function fetchSplMintAuthorities(port, mint) {
    const rawMint = stripChainPrefix(mint);
    const info = await port.call('getAccountInfo', [rawMint, { encoding: 'base64' }]);
    const account = info.value;
    if (!account) {
        throw new Error(`mint account ${mint} not found`);
    }
    return parseSplMintAuthorities(account.data[0]);
}
export function mintAuthorityFindings(authorities) {
    const findings = [];
    if (authorities.mintAuthority !== null) {
        findings.push({ flag: MINT_AUTHORITY_FLAG, detail: 'deployer can mint more supply' });
    }
    if (authorities.freezeAuthority !== null) {
        findings.push({ flag: FREEZE_AUTHORITY_FLAG, detail: 'deployer can freeze token accounts' });
    }
    return findings;
}
export function mintAuthorityCheck(port) {
    return async (context) => {
        try {
            return mintAuthorityFindings(await fetchSplMintAuthorities(port, context.baseTokenMint));
        }
        catch {
            return [];
        }
    };
}
const BURN_ADDRESSES = new Set(['1nc1nerator11111111111111111111111111111111', '11111111111111111111111111111111']);
export function liquidityLockFinding(snapshot) {
    const total = snapshot.lockedOrBurnedAmount + snapshot.movableAmount;
    if (total <= 0)
        return null;
    const movableShare = snapshot.movableAmount / total;
    // Below 10% movable the LP is effectively locked; above that, the deployer
    // (or an early LP) can pull the rug out from under the ladder.
    if (movableShare < 0.1)
        return null;
    return {
        flag: LIQUIDITY_UNLOCKED_FLAG,
        detail: `${(movableShare * 100).toFixed(1)}% of LP tokens sit in freely movable wallets`
    };
}
export function liquidityLockCheck(port, 
/** Resolves the pool's classic LP mint, or null — DLMM pools have none (positions are NFTs). */
resolveLpMint = () => null) {
    return async (context) => {
        const lpMint = resolveLpMint(context);
        if (!lpMint)
            return [];
        const [largest, supply] = await Promise.all([
            port.call('getTokenLargestAccounts', [lpMint]),
            port.call('getTokenSupply', [lpMint])
        ]);
        const lockedOrBurnedAmount = largest.value
            .filter((account) => BURN_ADDRESSES.has(account.address))
            .reduce((sum, account) => sum + Number(account.amount), 0);
        // Movable is supply MINUS what was observed locked/burned. Reading the raw
        // supply here (as the buckets were disjoint, this is not) would count every
        // locked LP token as movable and flag even fully-locked pools.
        const snapshot = {
            lockedOrBurnedAmount,
            movableAmount: Math.max(0, Number(supply.value.amount) - lockedOrBurnedAmount)
        };
        const finding = liquidityLockFinding(snapshot);
        return finding ? [finding] : [];
    };
}
//# sourceMappingURL=solana-checks.js.map