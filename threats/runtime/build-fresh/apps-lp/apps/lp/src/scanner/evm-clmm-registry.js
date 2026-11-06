export const EVM_CLMM_NETWORKS = {
    'robinhood-chain': {
        chain: 'robinhood-chain',
        defaultProtocol: 'uniswap-v3',
        defaultRpcEnvVar: 'ROBINHOOD_RPC_URL',
        fallbackRpcUrl: 'http://localhost:8545',
        nativeQuoteToken: {
            symbol: 'WETH',
            address: '0x4200000000000000000000000000000000000006',
            decimals: 18
        },
        stableTokens: ['0x0000000000000000000000000000000000000001']
    },
    base: {
        chain: 'base',
        defaultProtocol: 'uniswap-v3',
        defaultRpcEnvVar: 'BASE_RPC_URL',
        fallbackRpcUrl: 'https://mainnet.base.org',
        factoryAddress: '0x33128a8fC17869897dcE68Ed026d694621f6FDfD',
        positionManagerAddress: '0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1',
        nativeQuoteToken: {
            symbol: 'WETH',
            address: '0x4200000000000000000000000000000000000006',
            decimals: 18
        },
        stableTokens: [
            '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // USDC
            '0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA' // USDbC
        ]
    },
    ethereum: {
        chain: 'ethereum',
        defaultProtocol: 'uniswap-v3',
        defaultRpcEnvVar: 'ETHEREUM_RPC_URL',
        fallbackRpcUrl: 'https://eth.llamarpc.com',
        factoryAddress: '0x1F98431c8aD98523631AE4a59f267346ea31F984',
        positionManagerAddress: '0xC36442b4a4522E871399CD717aBDD847Ab11FE88',
        nativeQuoteToken: {
            symbol: 'WETH',
            address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
            decimals: 18
        },
        stableTokens: [
            '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', // USDC
            '0xdAC17F958D2ee523a2206206994597C13D831ec7' // USDT
        ]
    },
    bsc: {
        chain: 'bsc',
        defaultProtocol: 'pancakeswap-v3',
        defaultRpcEnvVar: 'BSC_RPC_URL',
        fallbackRpcUrl: 'https://binance.llamarpc.com',
        factoryAddress: '0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865',
        positionManagerAddress: '0x46A15B0b27311cedF172AB29E4f4766fbE521570',
        nativeQuoteToken: {
            symbol: 'WBNB',
            address: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',
            decimals: 18
        },
        stableTokens: [
            '0x55d398326f99059fF775485246999027B3197955', // USDT on BSC
            '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d' // USDC on BSC
        ]
    }
};
export function isEvmChain(chain) {
    return chain === 'robinhood-chain' || chain === 'base' || chain === 'ethereum' || chain === 'bsc';
}
export function getEvmClmmNetwork(chain) {
    const config = EVM_CLMM_NETWORKS[chain];
    if (!config) {
        throw new Error(`Unsupported EVM CLMM chain: ${chain}`);
    }
    return config;
}
export function resolveEvmRpcUrl(chain) {
    const config = getEvmClmmNetwork(chain);
    return process.env[config.defaultRpcEnvVar] ?? config.fallbackRpcUrl;
}
//# sourceMappingURL=evm-clmm-registry.js.map