import { createPublicClient, createWalletClient, decodeEventLog, encodeFunctionData, erc20Abi, formatEther, getAddress, http, parseAbi, parseEther, parseGwei } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { UnrecoverableError } from 'bullmq';
import { getActiveRpcUrl } from '@swat/shared';
import { capBaseUnitSpend } from './balances.js';
let robinhoodReadiness = {
    ready: false,
    reason: 'startup_verification_not_run',
    checkedAt: null
};
export function getRobinhoodLiveReadiness() {
    return {
        ...robinhoodReadiness,
        tuple: robinhoodReadiness.tuple ? { ...robinhoodReadiness.tuple } : undefined
    };
}
export function setRobinhoodLiveReadiness(next) {
    robinhoodReadiness = next;
}
function required(values, key) {
    const value = values[key]?.trim();
    if (!value)
        throw new Error(`${key} is required`);
    return value;
}
function address(values, key) {
    const value = required(values, key);
    try {
        return getAddress(value);
    }
    catch {
        throw new Error(`${key} must be a valid EVM address`);
    }
}
function positiveInteger(value, key) {
    if (!/^\d+$/.test(value))
        throw new Error(`${key} must be a positive integer`);
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed <= 0)
        throw new Error(`${key} must be a positive integer`);
    return parsed;
}
function positiveBigInt(value, key) {
    if (!/^\d+$/.test(value))
        throw new Error(`${key} must be a positive integer`);
    const parsed = BigInt(value);
    if (parsed <= 0n)
        throw new Error(`${key} must be a positive integer`);
    return parsed;
}
export function parseRobinhoodExecutionConfig(values = process.env) {
    const chainId = positiveInteger(required(values, 'ROBINHOOD_CHAIN_ID'), 'ROBINHOOD_CHAIN_ID');
    const router = address(values, 'ROBINHOOD_SWAP_ROUTER');
    const quoter = address(values, 'ROBINHOOD_QUOTER');
    const weth9 = address(values, 'ROBINHOOD_WETH9');
    const baseAsset = address(values, 'ROBINHOOD_BASE_ASSET');
    const sanityToken = address(values, 'ROBINHOOD_SANITY_TOKEN');
    const uniqueContracts = new Set([router.toLowerCase(), quoter.toLowerCase(), weth9.toLowerCase(), sanityToken.toLowerCase()]);
    if (uniqueContracts.size !== 4) {
        throw new Error('Robinhood router, quoter, WETH9, and sanity token must be distinct');
    }
    if (sanityToken.toLowerCase() === baseAsset.toLowerCase()) {
        throw new Error('ROBINHOOD_SANITY_TOKEN must be distinct from ROBINHOOD_BASE_ASSET');
    }
    const feeTiers = required(values, 'ROBINHOOD_FEE_TIERS').split(',').map((part) => positiveInteger(part.trim(), 'ROBINHOOD_FEE_TIERS'));
    if (new Set(feeTiers).size !== feeTiers.length || feeTiers.some((fee) => fee >= 1_000_000)) {
        throw new Error('ROBINHOOD_FEE_TIERS must contain unique values below 1000000');
    }
    const routerAbiVersion = required(values, 'ROBINHOOD_ROUTER_ABI_VERSION');
    if (routerAbiVersion !== 'uniswap-v3-swap-router-01' && routerAbiVersion !== 'uniswap-v3-swap-router-02') {
        throw new Error('ROBINHOOD_ROUTER_ABI_VERSION is unsupported');
    }
    const quoterAbiVersion = required(values, 'ROBINHOOD_QUOTER_ABI_VERSION');
    if (quoterAbiVersion !== 'uniswap-v3-quoter-v2') {
        throw new Error('ROBINHOOD_QUOTER_ABI_VERSION is unsupported');
    }
    const baseAssetMode = required(values, 'ROBINHOOD_BASE_ASSET_MODE');
    if (baseAssetMode !== 'native-weth' && baseAssetMode !== 'erc20') {
        throw new Error('ROBINHOOD_BASE_ASSET_MODE must be native-weth or erc20');
    }
    if (baseAssetMode === 'native-weth' && baseAsset.toLowerCase() !== weth9.toLowerCase()) {
        throw new Error('native-weth mode requires ROBINHOOD_BASE_ASSET to equal ROBINHOOD_WETH9');
    }
    const gasReserve = values.ROBINHOOD_GAS_RESERVE_ETH ?? '0.005';
    let gasReserveWei;
    try {
        gasReserveWei = parseEther(gasReserve);
    }
    catch {
        throw new Error('ROBINHOOD_GAS_RESERVE_ETH must be a non-negative decimal ETH amount');
    }
    if (gasReserveWei < 0n)
        throw new Error('ROBINHOOD_GAS_RESERVE_ETH must be non-negative');
    const maxFeeGwei = values.ROBINHOOD_MAX_FEE_PER_GAS_GWEI ?? '10';
    let maxFeePerGasWei;
    try {
        maxFeePerGasWei = parseGwei(maxFeeGwei);
    }
    catch {
        throw new Error('ROBINHOOD_MAX_FEE_PER_GAS_GWEI must be a positive decimal gwei amount');
    }
    if (maxFeePerGasWei <= 0n)
        throw new Error('ROBINHOOD_MAX_FEE_PER_GAS_GWEI must be positive');
    const receiptTimeoutMs = positiveInteger(values.ROBINHOOD_RECEIPT_TIMEOUT_MS ?? '60000', 'ROBINHOOD_RECEIPT_TIMEOUT_MS');
    if (receiptTimeoutMs > 120_000)
        throw new Error('ROBINHOOD_RECEIPT_TIMEOUT_MS cannot exceed 120000');
    const maxSlippageBps = positiveInteger(values.ROBINHOOD_MAX_SLIPPAGE_BPS ?? '500', 'ROBINHOOD_MAX_SLIPPAGE_BPS');
    if (maxSlippageBps > 1_000)
        throw new Error('ROBINHOOD_MAX_SLIPPAGE_BPS cannot exceed 1000');
    return {
        chainId,
        rpcUrl: values.ROBINHOOD_RPC_URL ?? getActiveRpcUrl('robinhood', values),
        router,
        quoter,
        weth9,
        baseAsset,
        sanityToken,
        feeTiers,
        routerAbiVersion,
        quoterAbiVersion,
        baseAssetMode,
        gasReserveWei,
        maxFeePerGasWei,
        maxSwapGas: positiveBigInt(values.ROBINHOOD_MAX_SWAP_GAS ?? '500000', 'ROBINHOOD_MAX_SWAP_GAS'),
        maxApprovalGas: positiveBigInt(values.ROBINHOOD_MAX_APPROVAL_GAS ?? '100000', 'ROBINHOOD_MAX_APPROVAL_GAS'),
        receiptTimeoutMs,
        maxSlippageBps
    };
}
const rpcUrl = getActiveRpcUrl('robinhood');
export const robinhoodPublicClient = createPublicClient({
    transport: http(rpcUrl)
});
const privateKey = process.env.EVM_PRIVATE_KEY;
export const evmAccount = privateKey ? privateKeyToAccount(privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`) : null;
export const robinhoodWalletClient = evmAccount ? createWalletClient({
    account: evmAccount,
    transport: http(rpcUrl)
}) : null;
// Compatibility exports are intentionally empty when strict deployment configuration is absent.
export const ROBINHOOD_UNISWAP_V3_ROUTER = process.env.ROBINHOOD_SWAP_ROUTER ?? '';
export const QUOTER_V2_ADDRESS = process.env.ROBINHOOD_QUOTER ?? '';
export const WETH_ROBINHOOD = process.env.ROBINHOOD_WETH9 ?? '';
export const QUOTER_ABI = parseAbi([
    'struct QuoteExactInputSingleParams { address tokenIn; address tokenOut; uint256 amountIn; uint24 fee; uint160 sqrtPriceLimitX96; }',
    'function quoteExactInputSingle(QuoteExactInputSingleParams params) external returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)'
]);
const router01Abi = parseAbi([
    'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) external payable returns (uint256 amountOut)'
]);
const router02Abi = parseAbi([
    'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) external payable returns (uint256 amountOut)'
]);
export const SWAP_ROUTER_ABI = router01Abi;
export function getRobinhoodRouterAbi(version) {
    return version === 'uniswap-v3-swap-router-01' ? router01Abi : router02Abi;
}
export function encodeRobinhoodSwapCalldata(input) {
    const common = {
        tokenIn: input.tokenIn,
        tokenOut: input.tokenOut,
        fee: input.fee,
        recipient: input.recipient,
        amountIn: input.amountIn,
        amountOutMinimum: input.amountOutMinimum,
        sqrtPriceLimitX96: 0n
    };
    const args = input.config.routerAbiVersion === 'uniswap-v3-swap-router-01'
        ? [{ ...common, deadline: input.deadline }]
        : [common];
    return encodeFunctionData({
        abi: getRobinhoodRouterAbi(input.config.routerAbiVersion),
        functionName: 'exactInputSingle',
        args
    });
}
export class RobinhoodRpcFailure extends Error {
}
function isRpcFailure(error) {
    if (error instanceof RobinhoodRpcFailure)
        return true;
    const name = error instanceof Error ? error.name : '';
    return /HttpRequest|Timeout|Socket|RpcRequest|Network/i.test(name);
}
export async function discoverRobinhoodRoute(input) {
    const routes = [];
    const failures = [];
    let rpcFailed = false;
    for (const fee of input.config.feeTiers) {
        try {
            const amountOut = await input.quote(input.tokenIn, input.tokenOut, input.amountIn, fee);
            if (amountOut > 0n)
                routes.push({ fee, amountOut });
            else
                failures.push(`${fee}: zero output`);
        }
        catch (error) {
            if (isRpcFailure(error))
                rpcFailed = true;
            failures.push(`${fee}: ${error instanceof Error ? error.message : 'quote failed'}`);
        }
    }
    if (routes.length > 0) {
        const best = routes.reduce((current, route) => route.amountOut > current.amountOut ? route : current);
        return { status: 'route', ...best };
    }
    return rpcFailed ? { status: 'rpc_failure', failures } : { status: 'no_route', failures };
}
export async function getRobinhoodQuote(tokenIn, tokenOut, amountInWei, feeTier = 3000) {
    const config = parseRobinhoodExecutionConfig();
    const { result } = await robinhoodPublicClient.simulateContract({
        address: config.quoter,
        abi: QUOTER_ABI,
        functionName: 'quoteExactInputSingle',
        args: [{
                tokenIn: getAddress(tokenIn),
                tokenOut: getAddress(tokenOut),
                amountIn: amountInWei,
                fee: feeTier,
                sqrtPriceLimitX96: 0n
            }]
    });
    return result[0];
}
export function evaluateRobinhoodSafety(assessment) {
    const reasons = [];
    for (const requiredName of ['sell_simulation', 'liquidity']) {
        const check = assessment.checks.find((candidate) => candidate.name === requiredName);
        if (!check || !check.reliable || check.status !== 'pass')
            reasons.push(`${requiredName} did not pass reliably`);
    }
    for (const check of assessment.checks) {
        if (check.reliable && check.status === 'fail')
            reasons.push(`${check.name}: ${check.evidence}`);
    }
    return reasons;
}
export function createMemoryRobinhoodPendingStore() {
    const records = new Map();
    const resolutions = new Map();
    return {
        async findUnresolved(clientOrderId) { return records.get(clientOrderId) ?? null; },
        async findResolution(clientOrderId) { return resolutions.get(clientOrderId) ?? null; },
        async listUnresolved() { return [...records.values()]; },
        async save(record) {
            records.set(record.clientOrderId, record);
            resolutions.delete(record.clientOrderId);
        },
        async resolve(clientOrderId, resolution) {
            records.delete(clientOrderId);
            resolutions.set(clientOrderId, resolution);
        }
    };
}
/**
 * Describes what a fill cost in the base asset, carrying the unit.
 *
 * Pure so it is testable without a chain, and shared by both result-construction
 * sites so they cannot disagree -- the `native-weth` and `erc20` branches
 * previously diverged only at a `: 0`, which is exactly the kind of difference
 * that hides.
 */
export function describeRobinhoodBaseSpend(input) {
    // On a buy the base asset is what went IN; on a sell it is what came OUT.
    const baseUnits = input.direction === 'buy' ? input.actualAmountIn : input.actualAmountOut;
    if (input.baseAssetMode === 'native-weth') {
        return { kind: 'native', currency: 'ETH', amount: Number(formatEther(baseUnits)) };
    }
    // Base units only -- deliberately NOT converted to a decimal here. The token's
    // decimals are a property of the token (USDG is 6, not 18), so formatting with
    // the ether helpers would understate the amount by 10^12 and present as "no
    // funds" rather than as a scaling bug. The caller that knows the decimals
    // converts; until then the integer is exact and the unit is explicit.
    return { kind: 'erc20', token: input.baseAsset, baseUnits };
}
/**
 * In-process submission serialisation, **keyed by account** (`S4-M12`).
 *
 * This was a single global chain, which was correct for one operator key and
 * becomes wrong the moment fan-out gives each user their own: every user's
 * mirror would queue behind every other user's, on a venue where being late is
 * the whole risk. Keyed by account, two users proceed concurrently while one
 * user's two overlapping signals still serialise — which is the only ordering
 * that nonce allocation actually requires.
 *
 * This layer is **necessary but not sufficient.** It is process-local, so two
 * executor replicas would each hold their own chain and both read the same
 * pending nonce. `EvmNonceLock` below is the cross-process half.
 */
const submissionTails = new Map();
async function withSubmissionLock(account, operation) {
    const key = account.toLowerCase();
    const previous = submissionTails.get(key) ?? Promise.resolve();
    let release;
    const mine = new Promise((resolve) => { release = resolve; });
    submissionTails.set(key, mine);
    await previous;
    try {
        return await operation();
    }
    finally {
        release();
        // Drop the entry once nothing is queued behind us, or the map grows one
        // permanently-resolved promise per account seen — a slow leak that only
        // shows up at fan-out scale, which is exactly when it would matter.
        if (submissionTails.get(key) === mine)
            submissionTails.delete(key);
    }
}
/**
 * Raised when the cross-process nonce lock is held elsewhere.
 *
 * A distinct class because the circuit breaker must **not** count this. Nothing
 * is wrong with the venue — another process is mid-submission — and three
 * unlucky collisions in a row would otherwise trip the breaker and halt all
 * Robinhood trading for `CIRCUIT_BREAKER_RESET_MS`. Deliberately NOT an
 * `UnrecoverableError`: the job should be retried, not buried.
 */
export class NonceContentionError extends Error {
    account;
    constructor(account) {
        super(`EVM nonce lock for ${account} is held by another process; retry`);
        this.account = account;
        this.name = 'NonceContentionError';
    }
}
function pendingResult(record) {
    return {
        status: 'pending_confirmation',
        clientOrderId: record.clientOrderId,
        transactionHash: record.hash,
        stage: record.stage,
        expiresAt: record.expiresAt
    };
}
const transferAbi = parseAbi([
    'event Transfer(address indexed from, address indexed to, uint256 value)'
]);
export function decodeRobinhoodActualAmounts(input) {
    const account = input.account.toLowerCase();
    const token = input.token.toLowerCase();
    const baseAsset = input.baseAsset.toLowerCase();
    const seen = new Set();
    let tokenFromAccount = 0n;
    let tokenToAccount = 0n;
    let baseFromAccount = 0n;
    let baseToAccount = 0n;
    for (const log of input.receipt.logs) {
        const key = `${log.transactionHash}:${log.logIndex}`;
        if (seen.has(key))
            continue;
        seen.add(key);
        if (log.topics.length !== 3 || !/^0x[0-9a-fA-F]{64}$/.test(log.data))
            continue;
        try {
            const decoded = decodeEventLog({ abi: transferAbi, data: log.data, topics: log.topics });
            const args = decoded.args;
            const address = log.address.toLowerCase();
            if (address === token && args.from.toLowerCase() === account)
                tokenFromAccount += args.value;
            if (address === token && args.to.toLowerCase() === account)
                tokenToAccount += args.value;
            if (address === baseAsset && args.from.toLowerCase() === account)
                baseFromAccount += args.value;
            if (address === baseAsset && args.to.toLowerCase() === account)
                baseToAccount += args.value;
        }
        catch {
            // Receipt logs with other event shapes are intentionally ignored.
        }
    }
    const actualAmountIn = input.direction === 'sell'
        ? tokenFromAccount
        : input.baseAssetMode === 'native-weth' ? input.submittedAmountIn : baseFromAccount;
    const actualAmountOut = input.direction === 'buy' ? tokenToAccount : baseToAccount;
    if (actualAmountIn <= 0n || actualAmountOut <= 0n) {
        throw new Error('successful receipt did not contain unambiguous account Transfer amounts');
    }
    return { actualAmountIn, actualAmountOut };
}
async function submitAndWait(input) {
    const submittedAt = new Date();
    const unknownRecord = {
        ...input.pending,
        stage: 'submission_unknown',
        hash: null,
        submittedAt,
        expiresAt: new Date(submittedAt.getTime() + 10 * 60_000)
    };
    await input.pendingStore.save(unknownRecord);
    let hash;
    try {
        hash = await input.adapter.send(input.call);
    }
    catch (error) {
        return pendingResult(unknownRecord);
    }
    const record = {
        ...input.pending,
        hash,
        submittedAt,
        expiresAt: new Date(submittedAt.getTime() + 10 * 60_000)
    };
    await input.pendingStore.save(record);
    let receipt;
    try {
        receipt = await input.adapter.waitForReceipt(hash, input.config.receiptTimeoutMs);
    }
    catch (error) {
        return pendingResult(record);
    }
    if (!receipt)
        return pendingResult(record);
    if (receipt.status !== 'success') {
        const result = {
            status: 'failed',
            state: 'reverted',
            reason: 'transaction receipt status is reverted',
            transactionHash: hash,
            clientOrderId: input.pending.clientOrderId
        };
        await input.pendingStore.resolve(input.pending.clientOrderId, result);
        return result;
    }
    return { receipt, hash };
}
export async function executeRobinhoodOrder(input) {
    // Two layers, innermost last: the per-account in-process chain orders this
    // process's work, then the cross-process lock excludes other replicas. The
    // whole order is inside the lock rather than just the nonce read — the nonce is
    // read, then incremented locally across an approval receipt wait, so releasing
    // any earlier would let a second process claim the nonce this one is about to
    // use for the swap. Over-locking costs latency; under-locking loses a fill.
    return withSubmissionLock(input.account, async () => {
        const lease = await input.nonceLock(input.account, async () => await runRobinhoodOrder(input));
        if (!lease.acquired)
            throw new NonceContentionError(input.account);
        return lease.result;
    });
}
async function runRobinhoodOrder(input) {
    return (async () => {
        if (input.requireReadiness !== false && !getRobinhoodLiveReadiness().ready) {
            return { status: 'skipped', state: 'safety_rejected', reason: getRobinhoodLiveReadiness().reason };
        }
        if (!input.order.clientOrderId.trim() || input.order.clientOrderId.length > 128) {
            return { status: 'skipped', state: 'safety_rejected', reason: 'invalid stable client order ID' };
        }
        if (input.order.slippageBps < 0 || input.order.slippageBps > input.config.maxSlippageBps) {
            return { status: 'skipped', state: 'safety_rejected', reason: 'slippage exceeds configured bound' };
        }
        const existing = await input.pendingStore.findUnresolved(input.order.clientOrderId);
        if (existing)
            return pendingResult(existing);
        const previousResolution = await input.pendingStore.findResolution(input.order.clientOrderId);
        if (previousResolution?.status === 'filled' || previousResolution?.status === 'failed') {
            return previousResolution;
        }
        const approvalAlreadyConfirmed = previousResolution?.status === 'approval_confirmed';
        const fees = await input.adapter.estimateFees().catch((error) => {
            throw new RobinhoodRpcFailure(error instanceof Error ? error.message : 'fee RPC failed');
        });
        if (fees.maxFeePerGas > input.config.maxFeePerGasWei) {
            return { status: 'skipped', state: 'gas_fee_cap', reason: 'network maxFeePerGas exceeds configured cap' };
        }
        const maxPriorityFeePerGas = fees.maxPriorityFeePerGas > fees.maxFeePerGas
            ? fees.maxFeePerGas
            : fees.maxPriorityFeePerGas;
        const tokenIn = input.order.direction === 'buy' ? input.config.baseAsset : input.order.token;
        const tokenOut = input.order.direction === 'buy' ? input.order.token : input.config.baseAsset;
        let amountIn;
        try {
            if (input.order.direction === 'sell') {
                const balance = await input.adapter.getTokenBalance(input.order.token, input.account);
                const proportion = input.order.proportionBps ?? 10_000;
                if (!Number.isInteger(proportion) || proportion <= 0 || proportion > 10_000) {
                    return { status: 'skipped', state: 'safety_rejected', reason: 'sell proportion must be 1..10000 bps' };
                }
                const proportional = balance * BigInt(proportion) / 10000n;
                amountIn = input.order.amountInBaseUnits === undefined
                    ? proportional
                    : input.order.amountInBaseUnits < proportional ? input.order.amountInBaseUnits : proportional;
            }
            else {
                if (!input.order.amountInBaseUnits || input.order.amountInBaseUnits <= 0n) {
                    return { status: 'skipped', state: 'safety_rejected', reason: 'BUY amount must be positive' };
                }
                amountIn = input.order.amountInBaseUnits;
            }
            const nativeBalance = await input.adapter.getNativeBalance(input.account);
            const needsApproval = input.order.direction === 'sell' || input.config.baseAssetMode === 'erc20';
            const maximumGas = input.config.maxSwapGas + (needsApproval && !approvalAlreadyConfirmed
                ? input.config.maxApprovalGas
                : 0n);
            const maxGasCost = maximumGas * fees.maxFeePerGas;
            if (input.order.direction === 'buy' && input.config.baseAssetMode === 'native-weth') {
                amountIn = capBaseUnitSpend(amountIn, nativeBalance - maxGasCost > 0n ? nativeBalance - maxGasCost : 0n, input.config.gasReserveWei);
            }
            else if (nativeBalance < input.config.gasReserveWei + maxGasCost) {
                return { status: 'skipped', state: 'gas_fee_cap', reason: 'native balance cannot preserve reserve and bounded swap fee' };
            }
        }
        catch (error) {
            return { status: 'failed', state: 'rpc_failure', reason: error instanceof Error ? error.message : 'balance RPC failed' };
        }
        if (amountIn <= 0n)
            return { status: 'skipped', state: 'gas_fee_cap', reason: 'spendable balance is zero after gas reserve' };
        const route = await discoverRobinhoodRoute({ ...input, tokenIn, tokenOut, amountIn, quote: input.adapter.quote });
        if (route.status !== 'route') {
            return route.status === 'no_route'
                ? { status: 'skipped', state: 'no_route', reason: route.failures.join('; ') }
                : { status: 'failed', state: 'rpc_failure', reason: route.failures.join('; ') };
        }
        const safetyReasons = evaluateRobinhoodSafety(await input.safetyAssessment({
            order: input.order,
            route,
            tokenIn,
            tokenOut
        }));
        if (safetyReasons.length > 0) {
            return { status: 'skipped', state: 'safety_rejected', reason: safetyReasons.join('; ') };
        }
        const minOut = route.amountOut * BigInt(10_000 - input.order.slippageBps) / 10000n;
        const deadline = BigInt(Math.floor((input.now?.() ?? Date.now()) / 1000) + 120);
        let nonce;
        try {
            nonce = await input.adapter.getPendingNonce(input.account);
        }
        catch (error) {
            return { status: 'failed', state: 'rpc_failure', reason: error instanceof Error ? error.message : 'nonce RPC failed' };
        }
        const needsApproval = input.order.direction === 'sell' || input.config.baseAssetMode === 'erc20';
        if (needsApproval && !approvalAlreadyConfirmed) {
            let allowance;
            try {
                allowance = await input.adapter.getAllowance(tokenIn, input.account, input.config.router);
            }
            catch (error) {
                return { status: 'failed', state: 'rpc_failure', reason: error instanceof Error ? error.message : 'allowance RPC failed' };
            }
            if (allowance !== amountIn) {
                const approvalCall = {
                    to: tokenIn,
                    data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [input.config.router, amountIn] }),
                    value: 0n,
                    maxFeePerGas: fees.maxFeePerGas,
                    maxPriorityFeePerGas,
                    nonce
                };
                try {
                    await input.adapter.simulate(approvalCall, input.account);
                    const gas = await input.adapter.estimateGas(approvalCall, input.account);
                    const bufferedGas = gas * 120n / 100n;
                    if (bufferedGas > input.config.maxApprovalGas)
                        return { status: 'skipped', state: 'gas_fee_cap', reason: 'approval gas exceeds configured cap' };
                    approvalCall.gas = bufferedGas;
                }
                catch (error) {
                    return { status: 'skipped', state: 'simulation_revert', reason: `exact approval simulation failed: ${error instanceof Error ? error.message : 'unknown'}` };
                }
                const approval = await submitAndWait({
                    call: approvalCall,
                    adapter: input.adapter,
                    account: input.account,
                    config: input.config,
                    pendingStore: input.pendingStore,
                    pending: {
                        clientOrderId: input.order.clientOrderId,
                        stage: 'approval',
                        direction: input.order.direction,
                        account: input.account,
                        token: input.order.token,
                        baseAsset: input.config.baseAsset,
                        amountIn: amountIn.toString(),
                        quotedAmountOut: route.amountOut.toString(),
                        feeTier: route.fee,
                        slippageBps: input.order.slippageBps
                    }
                });
                if (!('receipt' in approval))
                    return approval;
                await input.pendingStore.resolve(input.order.clientOrderId, { status: 'approval_confirmed', clientOrderId: input.order.clientOrderId });
                nonce++;
            }
        }
        const swapCall = {
            to: input.config.router,
            data: encodeRobinhoodSwapCalldata({
                config: input.config,
                tokenIn,
                tokenOut,
                fee: route.fee,
                recipient: input.account,
                deadline,
                amountIn,
                amountOutMinimum: minOut
            }),
            value: input.order.direction === 'buy' && input.config.baseAssetMode === 'native-weth' ? amountIn : 0n,
            maxFeePerGas: fees.maxFeePerGas,
            maxPriorityFeePerGas,
            nonce
        };
        try {
            await input.adapter.simulate(swapCall, input.account);
            const gas = await input.adapter.estimateGas(swapCall, input.account);
            const bufferedGas = gas * 120n / 100n;
            if (bufferedGas > input.config.maxSwapGas)
                return { status: 'skipped', state: 'gas_fee_cap', reason: 'swap gas exceeds configured cap' };
            swapCall.gas = bufferedGas;
        }
        catch (error) {
            return { status: 'skipped', state: 'simulation_revert', reason: error instanceof Error ? error.message : 'exact swap simulation reverted' };
        }
        const started = input.now?.() ?? Date.now();
        const submission = await submitAndWait({
            call: swapCall,
            adapter: input.adapter,
            account: input.account,
            config: input.config,
            pendingStore: input.pendingStore,
            pending: {
                clientOrderId: input.order.clientOrderId,
                stage: 'swap',
                direction: input.order.direction,
                account: input.account,
                token: input.order.token,
                baseAsset: input.config.baseAsset,
                amountIn: amountIn.toString(),
                quotedAmountOut: route.amountOut.toString(),
                feeTier: route.fee,
                slippageBps: input.order.slippageBps
            }
        });
        if (!('receipt' in submission))
            return submission;
        let actual;
        try {
            actual = decodeRobinhoodActualAmounts({
                receipt: submission.receipt,
                account: input.account,
                direction: input.order.direction,
                token: input.order.token,
                baseAsset: input.config.baseAsset,
                submittedAmountIn: amountIn,
                baseAssetMode: input.config.baseAssetMode
            });
        }
        catch (error) {
            const result = {
                status: 'failed',
                state: 'receipt_inconsistent',
                reason: error instanceof Error ? error.message : 'receipt decoding failed',
                transactionHash: submission.hash,
                clientOrderId: input.order.clientOrderId
            };
            await input.pendingStore.resolve(input.order.clientOrderId, result);
            return result;
        }
        const result = {
            status: 'filled',
            clientOrderId: input.order.clientOrderId,
            signature: submission.hash,
            transactionHash: submission.hash,
            amountEth: input.config.baseAssetMode === 'native-weth'
                ? Number(formatEther(input.order.direction === 'buy' ? actual.actualAmountIn : actual.actualAmountOut))
                : 0,
            baseSpend: describeRobinhoodBaseSpend({
                baseAssetMode: input.config.baseAssetMode,
                baseAsset: input.config.baseAsset,
                direction: input.order.direction,
                actualAmountIn: actual.actualAmountIn,
                actualAmountOut: actual.actualAmountOut
            }),
            actualAmountIn: actual.actualAmountIn,
            actualAmountOut: actual.actualAmountOut,
            quotedAmountOut: route.amountOut,
            feeTier: route.fee,
            gasUsed: submission.receipt.gasUsed,
            latencyMs: (input.now?.() ?? Date.now()) - started
        };
        await input.pendingStore.resolve(input.order.clientOrderId, result);
        return result;
    })();
}
export async function reconcileRobinhoodPending(input) {
    const now = input.now ?? new Date();
    const results = [];
    for (const pending of await input.pendingStore.listUnresolved()) {
        if (!pending.hash) {
            if (now >= pending.expiresAt) {
                const result = { status: 'failed', state: 'ambiguous', clientOrderId: pending.clientOrderId, reason: 'submission identity remained unknown for 10 minutes' };
                await input.pendingStore.resolve(pending.clientOrderId, result);
                results.push(result);
            }
            continue;
        }
        let receipt;
        try {
            receipt = await input.adapter.getReceipt(pending.hash);
        }
        catch (error) {
            results.push(pendingResult(pending));
            continue;
        }
        if (!receipt) {
            if (now >= pending.expiresAt) {
                const result = { status: 'failed', state: 'ambiguous', clientOrderId: pending.clientOrderId, transactionHash: pending.hash, reason: 'receipt remained unavailable for 10 minutes' };
                await input.pendingStore.resolve(pending.clientOrderId, result);
                results.push(result);
            }
            continue;
        }
        if (receipt.status !== 'success') {
            const result = { status: 'failed', state: 'reverted', clientOrderId: pending.clientOrderId, transactionHash: pending.hash, reason: 'transaction receipt status is reverted' };
            await input.pendingStore.resolve(pending.clientOrderId, result);
            results.push(result);
            continue;
        }
        if (pending.stage === 'approval') {
            const result = { status: 'approval_confirmed', clientOrderId: pending.clientOrderId };
            await input.pendingStore.resolve(pending.clientOrderId, result);
            results.push(result);
            if (input.safetyAssessment && input.nonceLock) {
                const resumed = await executeRobinhoodOrder({
                    nonceLock: input.nonceLock,
                    order: {
                        clientOrderId: pending.clientOrderId,
                        token: pending.token,
                        direction: pending.direction,
                        amountInBaseUnits: BigInt(pending.amountIn),
                        slippageBps: pending.slippageBps
                    },
                    config: input.config,
                    account: pending.account,
                    adapter: input.adapter,
                    pendingStore: input.pendingStore,
                    safetyAssessment: input.safetyAssessment
                });
                results.push({ ...resumed, clientOrderId: pending.clientOrderId });
            }
            continue;
        }
        let actual;
        try {
            actual = decodeRobinhoodActualAmounts({
                receipt,
                account: pending.account,
                direction: pending.direction,
                token: pending.token,
                baseAsset: pending.baseAsset,
                submittedAmountIn: BigInt(pending.amountIn),
                baseAssetMode: input.config.baseAssetMode
            });
        }
        catch (error) {
            const result = {
                status: 'failed',
                state: 'receipt_inconsistent',
                clientOrderId: pending.clientOrderId,
                transactionHash: pending.hash,
                reason: error instanceof Error ? error.message : 'receipt decoding failed'
            };
            await input.pendingStore.resolve(pending.clientOrderId, result);
            results.push(result);
            continue;
        }
        const result = {
            status: 'filled',
            clientOrderId: pending.clientOrderId,
            signature: pending.hash,
            transactionHash: pending.hash,
            amountEth: input.config.baseAssetMode === 'native-weth'
                ? Number(formatEther(pending.direction === 'buy' ? actual.actualAmountIn : actual.actualAmountOut))
                : 0,
            baseSpend: describeRobinhoodBaseSpend({
                baseAssetMode: input.config.baseAssetMode,
                baseAsset: input.config.baseAsset,
                direction: pending.direction,
                actualAmountIn: actual.actualAmountIn,
                actualAmountOut: actual.actualAmountOut
            }),
            actualAmountIn: actual.actualAmountIn,
            actualAmountOut: actual.actualAmountOut,
            quotedAmountOut: BigInt(pending.quotedAmountOut),
            feeTier: pending.feeTier,
            gasUsed: receipt.gasUsed,
            latencyMs: Math.max(0, now.getTime() - pending.submittedAt.getTime())
        };
        await input.pendingStore.resolve(pending.clientOrderId, result);
        results.push(result);
    }
    return results;
}
export function createViemRobinhoodAdapter(publicClient = robinhoodPublicClient, walletClient = robinhoodWalletClient) {
    if (!walletClient || !evmAccount)
        throw new Error('EVM_PRIVATE_KEY is not configured');
    return {
        quote: async (tokenIn, tokenOut, amountIn, fee) => {
            try {
                const config = parseRobinhoodExecutionConfig();
                const { result } = await publicClient.simulateContract({
                    address: config.quoter,
                    abi: QUOTER_ABI,
                    functionName: 'quoteExactInputSingle',
                    args: [{ tokenIn, tokenOut, amountIn, fee, sqrtPriceLimitX96: 0n }]
                });
                return result[0];
            }
            catch (error) {
                if (isRpcFailure(error))
                    throw new RobinhoodRpcFailure(error instanceof Error ? error.message : 'quote RPC failed');
                throw error;
            }
        },
        getNativeBalance: (owner) => publicClient.getBalance({ address: owner }),
        getTokenBalance: async (token, owner) => publicClient.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [owner] }),
        getAllowance: async (token, owner, spender) => publicClient.readContract({ address: token, abi: erc20Abi, functionName: 'allowance', args: [owner, spender] }),
        getPendingNonce: (owner) => publicClient.getTransactionCount({ address: owner, blockTag: 'pending' }),
        estimateFees: async () => {
            const fees = await publicClient.estimateFeesPerGas();
            return {
                maxFeePerGas: fees.maxFeePerGas,
                maxPriorityFeePerGas: fees.maxPriorityFeePerGas
            };
        },
        simulate: async (call, owner) => {
            await publicClient.call({ account: owner, ...call });
        },
        estimateGas: (call, owner) => publicClient.estimateGas({ account: owner, ...call }),
        send: async (call) => walletClient.sendTransaction({ account: evmAccount, chain: null, ...call }),
        waitForReceipt: async (hash, timeout) => {
            try {
                return await publicClient.waitForTransactionReceipt({ hash, timeout, confirmations: 1 });
            }
            catch (error) {
                if (/timeout/i.test(error instanceof Error ? `${error.name} ${error.message}` : ''))
                    return null;
                throw error;
            }
        },
        getReceipt: async (hash) => {
            try {
                return await publicClient.getTransactionReceipt({ hash });
            }
            catch (error) {
                if (/not found/i.test(error instanceof Error ? error.message : ''))
                    return null;
                throw error;
            }
        }
    };
}
let configuredPendingStore = null;
let configuredSafetyAssessment = null;
let configuredNonceLock = null;
export function configureRobinhoodRuntime(input) {
    configuredPendingStore = input.pendingStore;
    configuredSafetyAssessment = input.safetyAssessment;
    configuredNonceLock = input.nonceLock;
}
/** The configured cross-process nonce lock, for the reconciliation resume path. */
export function getConfiguredRobinhoodNonceLock() {
    return configuredNonceLock;
}
export async function getRobinhoodSpendableEth() {
    if (!evmAccount)
        throw new UnrecoverableError('EVM_PRIVATE_KEY is not configured for Robinhood Chain balance checks');
    const config = parseRobinhoodExecutionConfig();
    const balance = await robinhoodPublicClient.getBalance({ address: evmAccount.address });
    return Number(formatEther(capBaseUnitSpend(balance, balance, config.gasReserveWei)));
}
export class RobinhoodExecutionError extends UnrecoverableError {
    result;
    constructor(result) {
        super(`Robinhood ${result.status}: ${'reason' in result ? result.reason : result.stage}`);
        this.result = result;
    }
}
export async function triggerRobinhood(params) {
    if (!evmAccount || !robinhoodWalletClient)
        throw new UnrecoverableError('EVM_PRIVATE_KEY is not configured for Robinhood Chain live execution');
    if (!configuredPendingStore || !configuredSafetyAssessment || !configuredNonceLock) {
        // Fails closed on a missing nonce lock for the same reason as the pending
        // store: submitting without it is silently unserialised, and the symptom is
        // a fill that never happens rather than an error anyone sees.
        throw new UnrecoverableError('Robinhood restart-safe pending store, safety adapter and nonce lock are not configured');
    }
    const direction = params.direction ?? 'buy';
    if (direction === 'buy' && (!Number.isFinite(params.amountEth) || params.amountEth <= 0)) {
        throw new UnrecoverableError('Robinhood trade amount must be a positive finite amount');
    }
    const result = await executeRobinhoodOrder({
        order: {
            clientOrderId: params.signalId,
            token: getAddress(params.tokenMint),
            direction,
            amountInBaseUnits: params.amountInBaseUnits ?? (direction === 'buy' ? parseEther(params.amountEth.toFixed(18)) : undefined),
            proportionBps: params.proportionBps,
            slippageBps: params.slippageBps ?? 300
        },
        config: parseRobinhoodExecutionConfig(),
        account: evmAccount.address,
        adapter: createViemRobinhoodAdapter(),
        pendingStore: configuredPendingStore,
        safetyAssessment: configuredSafetyAssessment,
        nonceLock: configuredNonceLock
    });
    return result;
}
//# sourceMappingURL=robinhood.js.map