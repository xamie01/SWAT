import { createEvmClmmPoolFetcher, createViemEvmPoolReader, compressedTick, bitmapPosition, initializedTicksFromBitmap, reconstructTickBands } from './evm-clmm-pools.js';
export { compressedTick, bitmapPosition, initializedTicksFromBitmap, reconstructTickBands };
export function createViemRobinhoodPoolReader(options) {
    return createViemEvmPoolReader(options);
}
export function createRobinhoodPoolFetcher(options) {
    return createEvmClmmPoolFetcher({
        ...options,
        chain: 'robinhood-chain'
    });
}
//# sourceMappingURL=robinhood-pools.js.map