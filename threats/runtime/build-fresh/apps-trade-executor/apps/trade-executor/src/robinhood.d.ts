import { type Abi, type Hex, type PublicClient, type TransactionReceipt, type WalletClient } from 'viem';
import { UnrecoverableError } from 'bullmq';
export type RobinhoodRouterAbiVersion = 'uniswap-v3-swap-router-01' | 'uniswap-v3-swap-router-02';
export type RobinhoodBaseAssetMode = 'native-weth' | 'erc20';
export type RobinhoodExecutionConfig = {
    chainId: number;
    rpcUrl: string;
    router: `0x${string}`;
    quoter: `0x${string}`;
    weth9: `0x${string}`;
    baseAsset: `0x${string}`;
    sanityToken: `0x${string}`;
    feeTiers: number[];
    routerAbiVersion: RobinhoodRouterAbiVersion;
    quoterAbiVersion: 'uniswap-v3-quoter-v2';
    baseAssetMode: RobinhoodBaseAssetMode;
    gasReserveWei: bigint;
    maxFeePerGasWei: bigint;
    maxSwapGas: bigint;
    maxApprovalGas: bigint;
    receiptTimeoutMs: number;
    maxSlippageBps: number;
};
export type RobinhoodReadiness = {
    ready: boolean;
    reason: string;
    checkedAt: Date | null;
    tuple?: {
        chainId: number;
        router: string;
        quoter: string;
        weth9: string;
        baseAsset: string;
        sanityToken: string;
        feeTiers: number[];
        routerAbiVersion: RobinhoodRouterAbiVersion;
        quoterAbiVersion: 'uniswap-v3-quoter-v2';
    };
};
export declare function getRobinhoodLiveReadiness(): RobinhoodReadiness;
export declare function setRobinhoodLiveReadiness(next: RobinhoodReadiness): void;
export declare function parseRobinhoodExecutionConfig(values?: Record<string, string | undefined>): RobinhoodExecutionConfig;
export declare const robinhoodPublicClient: PublicClient;
export declare const evmAccount: {
    address: import("viem").Address;
    nonceManager?: import("viem").NonceManager | undefined;
    sign: (parameters: {
        hash: import("viem").Hash;
    }) => Promise<Hex>;
    signAuthorization: (parameters: import("viem").AuthorizationRequest) => Promise<import("viem/accounts").SignAuthorizationReturnType>;
    signMessage: ({ message }: {
        message: import("viem").SignableMessage;
    }) => Promise<Hex>;
    signTransaction: <serializer extends import("viem").SerializeTransactionFn<import("viem").TransactionSerializable> = import("viem").SerializeTransactionFn<import("viem").TransactionSerializable>, transaction extends Parameters<serializer>[0] = Parameters<serializer>[0]>(transaction: transaction, options?: {
        serializer?: serializer | undefined;
    } | undefined) => Promise<Hex>;
    signTypedData: <const typedData extends import("viem").TypedData | Record<string, unknown>, primaryType extends keyof typedData | "EIP712Domain" = keyof typedData>(parameters: import("viem").TypedDataDefinition<typedData, primaryType>) => Promise<Hex>;
    publicKey: Hex;
    source: "privateKey";
    type: "local";
} | null;
export declare const robinhoodWalletClient: WalletClient | null;
export declare const ROBINHOOD_UNISWAP_V3_ROUTER: string;
export declare const QUOTER_V2_ADDRESS: string;
export declare const WETH_ROBINHOOD: string;
export declare const QUOTER_ABI: readonly [{
    readonly name: "quoteExactInputSingle";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "tuple";
        readonly components: readonly [{
            readonly type: "address";
            readonly name: "tokenIn";
        }, {
            readonly type: "address";
            readonly name: "tokenOut";
        }, {
            readonly type: "uint256";
            readonly name: "amountIn";
        }, {
            readonly type: "uint24";
            readonly name: "fee";
        }, {
            readonly type: "uint160";
            readonly name: "sqrtPriceLimitX96";
        }];
        readonly name: "params";
    }];
    readonly outputs: readonly [{
        readonly type: "uint256";
        readonly name: "amountOut";
    }, {
        readonly type: "uint160";
        readonly name: "sqrtPriceX96After";
    }, {
        readonly type: "uint32";
        readonly name: "initializedTicksCrossed";
    }, {
        readonly type: "uint256";
        readonly name: "gasEstimate";
    }];
}];
export declare const SWAP_ROUTER_ABI: readonly [{
    readonly name: "exactInputSingle";
    readonly type: "function";
    readonly stateMutability: "payable";
    readonly inputs: readonly [{
        readonly type: "tuple";
        readonly components: readonly [{
            readonly type: "address";
            readonly name: "tokenIn";
        }, {
            readonly type: "address";
            readonly name: "tokenOut";
        }, {
            readonly type: "uint24";
            readonly name: "fee";
        }, {
            readonly type: "address";
            readonly name: "recipient";
        }, {
            readonly type: "uint256";
            readonly name: "deadline";
        }, {
            readonly type: "uint256";
            readonly name: "amountIn";
        }, {
            readonly type: "uint256";
            readonly name: "amountOutMinimum";
        }, {
            readonly type: "uint160";
            readonly name: "sqrtPriceLimitX96";
        }];
    }];
    readonly outputs: readonly [{
        readonly type: "uint256";
        readonly name: "amountOut";
    }];
}];
export declare function getRobinhoodRouterAbi(version: RobinhoodRouterAbiVersion): Abi;
export declare function encodeRobinhoodSwapCalldata(input: {
    config: RobinhoodExecutionConfig;
    tokenIn: `0x${string}`;
    tokenOut: `0x${string}`;
    fee: number;
    recipient: `0x${string}`;
    deadline: bigint;
    amountIn: bigint;
    amountOutMinimum: bigint;
}): Hex;
export declare class RobinhoodRpcFailure extends Error {
}
export type RobinhoodQuoteAdapter = (tokenIn: `0x${string}`, tokenOut: `0x${string}`, amountIn: bigint, fee: number) => Promise<bigint>;
export type RobinhoodRouteResult = {
    status: 'route';
    fee: number;
    amountOut: bigint;
} | {
    status: 'no_route';
    failures: string[];
} | {
    status: 'rpc_failure';
    failures: string[];
};
export declare function discoverRobinhoodRoute(input: {
    config: RobinhoodExecutionConfig;
    tokenIn: `0x${string}`;
    tokenOut: `0x${string}`;
    amountIn: bigint;
    quote: RobinhoodQuoteAdapter;
}): Promise<RobinhoodRouteResult>;
export declare function getRobinhoodQuote(tokenIn: string, tokenOut: string, amountInWei: bigint, feeTier?: number): Promise<bigint>;
export type RobinhoodSafetyCheck = {
    name: 'sell_simulation' | 'ownership_admin' | 'liquidity' | 'source_verification' | 'holder_concentration' | 'fee_on_transfer';
    status: 'pass' | 'fail' | 'unknown';
    reliable: boolean;
    evidence: string;
};
export type RobinhoodSafetyAssessment = {
    checks: RobinhoodSafetyCheck[];
};
export declare function evaluateRobinhoodSafety(assessment: RobinhoodSafetyAssessment): string[];
export type RobinhoodTransactionCall = {
    to: `0x${string}`;
    data: Hex;
    value: bigint;
    gas?: bigint;
    maxFeePerGas?: bigint;
    maxPriorityFeePerGas?: bigint;
    nonce?: number;
};
export interface RobinhoodExecutionAdapter {
    quote: RobinhoodQuoteAdapter;
    getNativeBalance(address: `0x${string}`): Promise<bigint>;
    getTokenBalance(token: `0x${string}`, address: `0x${string}`): Promise<bigint>;
    getAllowance(token: `0x${string}`, owner: `0x${string}`, spender: `0x${string}`): Promise<bigint>;
    getPendingNonce(address: `0x${string}`): Promise<number>;
    estimateFees(): Promise<{
        maxFeePerGas: bigint;
        maxPriorityFeePerGas: bigint;
    }>;
    simulate(call: RobinhoodTransactionCall, account: `0x${string}`): Promise<void>;
    estimateGas(call: RobinhoodTransactionCall, account: `0x${string}`): Promise<bigint>;
    send(call: Required<Pick<RobinhoodTransactionCall, 'to' | 'data' | 'value' | 'gas' | 'maxFeePerGas' | 'maxPriorityFeePerGas' | 'nonce'>>): Promise<Hex>;
    waitForReceipt(hash: Hex, timeoutMs: number): Promise<TransactionReceipt | null>;
    getReceipt(hash: Hex): Promise<TransactionReceipt | null>;
}
export type PendingRobinhoodSubmission = {
    clientOrderId: string;
    stage: 'approval' | 'swap' | 'submission_unknown';
    hash: Hex | null;
    submittedAt: Date;
    expiresAt: Date;
    direction: 'buy' | 'sell';
    account: `0x${string}`;
    token: `0x${string}`;
    baseAsset: `0x${string}`;
    amountIn: string;
    quotedAmountOut: string;
    feeTier: number | null;
    slippageBps: number;
};
export interface RobinhoodPendingStore {
    findUnresolved(clientOrderId: string): Promise<PendingRobinhoodSubmission | null>;
    findResolution(clientOrderId: string): Promise<RobinhoodReconciliationResult | null>;
    listUnresolved(): Promise<PendingRobinhoodSubmission[]>;
    save(record: PendingRobinhoodSubmission): Promise<void>;
    resolve(clientOrderId: string, resolution: RobinhoodReconciliationResult): Promise<void>;
}
export declare function createMemoryRobinhoodPendingStore(): RobinhoodPendingStore;
/**
 * What the fill actually cost, in the base asset, with its unit.
 *
 * Exists because `amountEth` cannot express the `erc20` base-asset mode: it is a
 * `number` whose name hardcodes a currency that only one of the two modes uses.
 * In `erc20` mode it was set to `0`, and the ledger recorded that zero as a real
 * ETH cost -- a fabricated value on a trade that spent a stablecoin (S4-M41).
 *
 * `kind: 'unassessed'` is the honest answer when the spend cannot be expressed in
 * a currency the ledger accepts. It is deliberately NOT the number zero: a zero
 * cost basis makes an ordinary position look like an infinite-return winner, and
 * one that can never trip a stop-loss.
 */
export type RobinhoodBaseSpend = {
    readonly kind: 'native';
    readonly currency: 'ETH';
    readonly amount: number;
} | {
    readonly kind: 'erc20';
    readonly token: `0x${string}`;
    readonly baseUnits: bigint;
} | {
    readonly kind: 'unassessed';
    readonly reason: string;
};
/**
 * Describes what a fill cost in the base asset, carrying the unit.
 *
 * Pure so it is testable without a chain, and shared by both result-construction
 * sites so they cannot disagree -- the `native-weth` and `erc20` branches
 * previously diverged only at a `: 0`, which is exactly the kind of difference
 * that hides.
 */
export declare function describeRobinhoodBaseSpend(input: {
    baseAssetMode: 'native-weth' | 'erc20';
    baseAsset: `0x${string}`;
    direction: 'buy' | 'sell';
    actualAmountIn: bigint;
    actualAmountOut: bigint;
}): RobinhoodBaseSpend;
export type RobinhoodFilledResult = {
    status: 'filled';
    clientOrderId: string;
    signature: Hex;
    transactionHash: Hex;
    /**
     * Legacy ETH-denominated amount. Meaningful ONLY in `native-weth` mode, where
     * it equals `baseSpend.amount`; `0` in `erc20` mode, which is why `baseSpend`
     * exists. Retained because sizing and alerting still read it. **Never write
     * this into the ledger directly** -- read `baseSpend`.
     */
    amountEth: number;
    /** The unit-carrying spend. Prefer this over `amountEth` (S4-M41). */
    baseSpend: RobinhoodBaseSpend;
    actualAmountIn: bigint;
    actualAmountOut: bigint;
    quotedAmountOut: bigint;
    feeTier: number | null;
    gasUsed: bigint;
    latencyMs: number;
};
export type RobinhoodExecutionResult = RobinhoodFilledResult | {
    status: 'skipped';
    state: 'no_route' | 'simulation_revert' | 'safety_rejected' | 'gas_fee_cap';
    reason: string;
    clientOrderId?: string;
} | {
    status: 'failed';
    state: 'rpc_failure' | 'reverted' | 'ambiguous' | 'receipt_inconsistent';
    reason: string;
    transactionHash?: Hex;
    clientOrderId?: string;
} | {
    status: 'pending_confirmation';
    clientOrderId: string;
    transactionHash: Hex | null;
    stage: PendingRobinhoodSubmission['stage'];
    expiresAt: Date;
};
export type RobinhoodOrder = {
    clientOrderId: string;
    token: `0x${string}`;
    direction: 'buy' | 'sell';
    amountInBaseUnits?: bigint;
    proportionBps?: number;
    slippageBps: number;
};
/**
 * Cross-process nonce lock, injected rather than imported (`S4-M12`).
 *
 * A port, not a database call, for the same reason the signer is a parameter
 * (Standing Rule 2): this module stays free of `@swat/db` and therefore testable
 * without one. The provider binds the chain and is wired in `index.ts`.
 *
 * Returns `{acquired: false}` rather than blocking. A blocking wait would sit
 * past the BullMQ job's lock duration and get the job declared stalled, which is
 * a worse outcome than a clean retry once the current holder has submitted and
 * the node's pending nonce has advanced.
 */
export type EvmNonceLock = <T>(account: string, run: () => Promise<T>) => Promise<{
    acquired: true;
    result: T;
} | {
    acquired: false;
    result?: undefined;
}>;
/**
 * Raised when the cross-process nonce lock is held elsewhere.
 *
 * A distinct class because the circuit breaker must **not** count this. Nothing
 * is wrong with the venue — another process is mid-submission — and three
 * unlucky collisions in a row would otherwise trip the breaker and halt all
 * Robinhood trading for `CIRCUIT_BREAKER_RESET_MS`. Deliberately NOT an
 * `UnrecoverableError`: the job should be retried, not buried.
 */
export declare class NonceContentionError extends Error {
    readonly account: string;
    constructor(account: string);
}
export declare function decodeRobinhoodActualAmounts(input: {
    receipt: TransactionReceipt;
    account: `0x${string}`;
    direction: 'buy' | 'sell';
    token: `0x${string}`;
    baseAsset: `0x${string}`;
    submittedAmountIn: bigint;
    baseAssetMode: RobinhoodBaseAssetMode;
}): {
    actualAmountIn: bigint;
    actualAmountOut: bigint;
};
export declare function executeRobinhoodOrder(input: {
    order: RobinhoodOrder;
    config: RobinhoodExecutionConfig;
    account: `0x${string}`;
    adapter: RobinhoodExecutionAdapter;
    pendingStore: RobinhoodPendingStore;
    safetyAssessment: (context: {
        order: RobinhoodOrder;
        route: Extract<RobinhoodRouteResult, {
            status: 'route';
        }>;
        tokenIn: `0x${string}`;
        tokenOut: `0x${string}`;
    }) => Promise<RobinhoodSafetyAssessment>;
    now?: () => number;
    requireReadiness?: boolean;
    /**
     * Cross-process nonce lock (`S4-M12`). **Required, not optional** — an absent
     * lock is indistinguishable from a working one until two processes race, and
     * the failure is a vanished fill with no error anywhere. Tests pass a
     * pass-through; `index.ts` passes the Postgres-backed one.
     */
    nonceLock: EvmNonceLock;
}): Promise<RobinhoodExecutionResult>;
export type RobinhoodReconciliationResult = RobinhoodFilledResult | {
    status: 'approval_confirmed';
    clientOrderId: string;
} | {
    status: 'failed';
    state: 'reverted' | 'rpc_failure' | 'ambiguous' | 'receipt_inconsistent';
    clientOrderId: string;
    transactionHash?: Hex;
    reason: string;
};
export type RobinhoodReconciliationOutcome = RobinhoodReconciliationResult | RobinhoodExecutionResult;
export declare function reconcileRobinhoodPending(input: {
    adapter: RobinhoodExecutionAdapter;
    pendingStore: RobinhoodPendingStore;
    config: RobinhoodExecutionConfig;
    safetyAssessment?: Parameters<typeof executeRobinhoodOrder>[0]['safetyAssessment'];
    /**
     * Needed because a confirmed approval **resumes into a swap** below, and that
     * swap allocates a nonce like any other. Optional only in the sense that
     * `safetyAssessment` is: without both, the resume is skipped rather than run
     * unserialised.
     */
    nonceLock?: EvmNonceLock;
    now?: Date;
}): Promise<RobinhoodReconciliationOutcome[]>;
export declare function createViemRobinhoodAdapter(publicClient?: PublicClient, walletClient?: WalletClient | null): RobinhoodExecutionAdapter;
export declare function configureRobinhoodRuntime(input: {
    pendingStore: RobinhoodPendingStore;
    safetyAssessment: Parameters<typeof executeRobinhoodOrder>[0]['safetyAssessment'];
    nonceLock: EvmNonceLock;
}): void;
/** The configured cross-process nonce lock, for the reconciliation resume path. */
export declare function getConfiguredRobinhoodNonceLock(): EvmNonceLock | null;
export declare function getRobinhoodSpendableEth(): Promise<number>;
export declare class RobinhoodExecutionError extends UnrecoverableError {
    readonly result: Exclude<RobinhoodExecutionResult, RobinhoodFilledResult>;
    constructor(result: Exclude<RobinhoodExecutionResult, RobinhoodFilledResult>);
}
export declare function triggerRobinhood(params: {
    signalId: string;
    tokenMint: string;
    amountEth: number;
    slippageBps?: number;
    direction?: 'buy' | 'sell';
    amountInBaseUnits?: bigint;
    proportionBps?: number;
}): Promise<RobinhoodExecutionResult>;
//# sourceMappingURL=robinhood.d.ts.map