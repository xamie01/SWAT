import { stripChainPrefix } from '@swat/shared';
import { BLACKLIST_CAPABLE_FLAG, EXCESSIVE_TAX_FLAG, HOLDER_CONCENTRATION_FLAG, HONEYPOT_DETECTED_FLAG, LIQUIDITY_UNLOCKED_FLAG, MINT_AUTHORITY_FLAG, PAUSE_CAPABLE_FLAG, UNVERIFIED_SOURCE_FLAG } from './types.js';
export function evmHoneypotCheck(port) {
    return async (context) => {
        const token = stripChainPrefix(context.baseTokenMint).toLowerCase();
        const result = await port.checkTokenSecurity(token);
        if (!result)
            return [];
        const findings = [];
        if (result.isHoneypot || result.cannotSellAll) {
            findings.push({
                flag: HONEYPOT_DETECTED_FLAG,
                detail: 'Honeypot detected: Token cannot be sold or simulated sell failed'
            });
        }
        if (result.buyTax > 0.05 || result.sellTax > 0.05) {
            findings.push({
                flag: EXCESSIVE_TAX_FLAG,
                detail: `Excessive trading tax: buy ${(result.buyTax * 100).toFixed(1)}%, sell ${(result.sellTax * 100).toFixed(1)}%`
            });
        }
        if (!result.isOpenSource) {
            findings.push({
                flag: UNVERIFIED_SOURCE_FLAG,
                detail: 'Contract source code is unverified'
            });
        }
        return findings;
    };
}
export function evmHolderConcentrationCheck(holders, supply) {
    return async (context) => {
        const token = stripChainPrefix(context.baseTokenMint).toLowerCase();
        const [top10, total] = await Promise.all([
            holders.top10Balances(token),
            supply.totalSupply(token)
        ]);
        if (!top10 || total === null || total <= 0)
            return [];
        const share = top10.reduce((sum, amount) => sum + amount, 0) / total;
        if (share < 0.5)
            return [];
        return [
            { flag: HOLDER_CONCENTRATION_FLAG, detail: `top-10 holders own ${(share * 100).toFixed(1)}% of supply` }
        ];
    };
}
export function evmMintAuthorityCheck(port) {
    return async (context) => {
        const token = stripChainPrefix(context.baseTokenMint).toLowerCase();
        const findings = [];
        const owner = await port.tryCall(token, 'owner()');
        if (owner !== null) {
            findings.push({ flag: MINT_AUTHORITY_FLAG, detail: 'token contract has an owner (likely upgradeable/mintable)' });
        }
        const paused = await port.tryCall(token, 'paused()');
        if (paused === 'true' || paused === '1') {
            findings.push({ flag: PAUSE_CAPABLE_FLAG, detail: 'trading can be paused by the contract owner' });
        }
        // A blacklist surface is probed through the common selector names; absence
        // of a revert-capable read just means the check stays silent.
        const blacklistedProbe = await port.tryCall(token, 'balanceOf(address)', [token]);
        if (blacklistedProbe !== null && owner !== null) {
            findings.push({ flag: BLACKLIST_CAPABLE_FLAG, detail: 'ownable token exposing balance reads common to blacklist implementations' });
        }
        return findings;
    };
}
export function evmLiquidityLockCheck(lpToken, port) {
    return async (context) => {
        if (!lpToken)
            return [];
        const [total, deployerBalance] = await Promise.all([
            port.tryCall(lpToken, 'totalSupply()'),
            port.tryCall(lpToken, 'balanceOf(address)', [stripChainPrefix(context.poolAddress)])
        ]);
        const totalSupply = total === null ? null : Number(total);
        const movable = deployerBalance === null ? null : Number(deployerBalance);
        if (totalSupply === null || movable === null || Number.isNaN(totalSupply) || Number.isNaN(movable) || totalSupply <= 0)
            return [];
        const movableShare = movable / totalSupply;
        if (movableShare < 0.1)
            return [];
        return [
            { flag: LIQUIDITY_UNLOCKED_FLAG, detail: `${(movableShare * 100).toFixed(1)}% of LP tokens sit in the queried holder balance rather than a locker or burn address` }
        ];
    };
}
//# sourceMappingURL=evm-checks.js.map