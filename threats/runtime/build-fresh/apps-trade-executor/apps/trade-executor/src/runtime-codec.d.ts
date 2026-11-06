export interface RedisHashClient {
    hget(key: string, field: string): Promise<string | null>;
    hgetall(key: string): Promise<Record<string, string>>;
    hset(key: string, field: string, value: string): Promise<unknown>;
}
export declare function encodeRuntimeValue(value: unknown): string;
export declare function decodeRuntimeValue<T>(encoded: string): T;
//# sourceMappingURL=runtime-codec.d.ts.map