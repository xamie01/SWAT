import type { SolanaRpcPort } from './solana-checks.js';
export declare function createJsonRpcSolanaPort(rpcUrl: string, options?: {
    timeoutMs?: number;
    maxRetries?: number;
    fetchImpl?: typeof fetch;
}): SolanaRpcPort;
//# sourceMappingURL=solana-rpc.d.ts.map