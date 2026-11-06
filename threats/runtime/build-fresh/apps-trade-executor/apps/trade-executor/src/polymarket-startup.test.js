import { production, SignatureType } from '@polymarket/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@swat/db', () => ({
    resolveChainMode: vi.fn()
}));
import { assertAuthenticatedCollateralBalance, assertOfficialPolymarketContractConfig, assertPolymarketContractBytecode, parseBooleanEnvironment, parseFeeBufferBps, parseUsdUnits, verifyPolymarketEnvironment } from './polymarket-startup.js';
import { getPolymarketLiveReadiness, setPolymarketLiveReadiness } from './polymarket.js';
import { POLYMARKET_CONTRACTS } from './polymarket-collateral.js';
const SIGNER = '0x1111111111111111111111111111111111111111';
const ACCOUNT_WALLET = '0x2222222222222222222222222222222222222222';
function createGateway(overrides = {}) {
    return {
        getPusdDecimals: vi.fn().mockResolvedValue(6),
        getUsdcEDecimals: vi.fn().mockResolvedValue(6),
        getPusdBalance: vi.fn().mockResolvedValue(10000000n),
        getUsdcEBalance: vi.fn().mockResolvedValue(0n),
        getUsdcEAllowance: vi.fn().mockResolvedValue(0n),
        approveUsdcE: vi.fn().mockResolvedValue('0x-usdce'),
        wrapUsdcE: vi.fn().mockResolvedValue('0x-wrap'),
        getPusdAllowance: vi.fn().mockResolvedValue(10000000n),
        approvePusd: vi.fn().mockResolvedValue('0x-pusd'),
        isConditionalTokenApproved: vi.fn().mockResolvedValue(true),
        approveConditionalTokenOperator: vi.fn().mockResolvedValue('0x-conditional'),
        ...overrides
    };
}
function eoaIdentity() {
    return {
        signerAddress: SIGNER,
        funderAddress: SIGNER,
        signatureType: SignatureType.EOA,
        signatureTypeName: 'EOA',
        builderCode: `0x${'a'.repeat(64)}`,
        directWalletWritesAllowed: true,
        credentialSource: 'derived',
        builderAuthentication: 'none',
        builderMakerFeeBps: 0,
        builderTakerFeeBps: 0
    };
}
function startupDependencies(overrides = {}) {
    return {
        resolveMode: vi.fn().mockResolvedValue({ effectiveMode: 'live' }),
        getNetwork: vi.fn().mockResolvedValue({ chainId: 137 }),
        getCode: vi.fn(async (address) => address.toLowerCase() === SIGNER.toLowerCase()
            ? '0x'
            : '0x6000'),
        initializeClient: vi.fn().mockResolvedValue(eoaIdentity()),
        createCollateralGateway: vi.fn(() => createGateway()),
        getAuthenticatedCollateralBalance: vi.fn().mockResolvedValue(10),
        sdkProduction: production,
        clobHost: 'https://clob.polymarket.com',
        env: {
            POLYMARKET_MIN_PUSD_BALANCE_USD: '1',
            POLYMARKET_ALLOWANCE_CAP_USD: '10',
            POLYMARKET_FEE_BUFFER_BPS: '0',
            POLYMARKET_AUTO_ONRAMP: 'false',
            POLYMARKET_AUTO_APPROVE: 'false'
        },
        ...overrides
    };
}
describe('Polymarket startup configuration', () => {
    beforeEach(() => {
        vi.spyOn(console, 'log').mockImplementation(() => undefined);
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
    });
    afterEach(() => {
        vi.restoreAllMocks();
        setPolymarketLiveReadiness(false, 'test cleanup');
    });
    it('accepts the SDK Polygon production environment and official inventory', () => {
        expect(() => assertOfficialPolymarketContractConfig()).not.toThrow();
    });
    it('rejects mismatched SDK addresses and non-production CLOB origins', () => {
        const mismatched = JSON.parse(JSON.stringify(production));
        mismatched.contracts.standardExchange = '0x3333333333333333333333333333333333333333';
        expect(() => assertOfficialPolymarketContractConfig(mismatched)).toThrow('does not match the pinned SDK production address');
        expect(() => assertOfficialPolymarketContractConfig(production, 'https://clob.polymarket.com.attacker.example')).toThrow('not the official production CLOB origin');
    });
    it('accepts deployed bytecode and rejects empty, zero, odd, or malformed code', () => {
        expect(() => assertPolymarketContractBytecode('test', '0x1234', '0x6000')).not.toThrow();
        for (const code of ['0x', '0x0000', '0x600', 'not-hex']) {
            expect(() => assertPolymarketContractBytecode('test', '0x1234', code)).toThrow('has no deployed bytecode');
        }
    });
    it('parses bounded startup settings', () => {
        expect(parseUsdUnits('12.345678', 'TEST_USD', '1')).toBe(12345678n);
        expect(() => parseUsdUnits('1.0000001', 'TEST_USD', '1')).toThrow('at most 6 places');
        expect(parseFeeBufferBps('')).toBe(300n);
        expect(() => parseFeeBufferBps('5001')).toThrow('between 0 and 5000');
        expect(parseBooleanEnvironment('true', 'TEST_FLAG')).toBe(true);
        expect(parseBooleanEnvironment('false', 'TEST_FLAG')).toBe(false);
        expect(() => parseBooleanEnvironment('TRUE', 'TEST_FLAG')).toThrow('exactly true or false');
    });
    it('validates authenticated balance minimums and rejects impossible CLOB state', () => {
        expect(() => assertAuthenticatedCollateralBalance(1, 1000000n, 1000000n)).not.toThrow();
        expect(() => assertAuthenticatedCollateralBalance(0.999999, 1000000n, 1000000n)).toThrow('below the configured live minimum');
        expect(() => assertAuthenticatedCollateralBalance(2, 1000000n, 1000000n)).toThrow('exceeds the attested onchain pUSD balance');
        expect(() => assertAuthenticatedCollateralBalance(Number.NaN, 1000000n, 1000000n)).toThrow('invalid collateral balance');
    });
    it('completes bounded EOA startup attestation without changing certification state', async () => {
        const result = await verifyPolymarketEnvironment(startupDependencies());
        expect(result).toBe(true);
        expect(getPolymarketLiveReadiness()).toEqual({ ready: true, reason: 'verified' });
    });
    it('returns without RPC or CLOB calls when database policy is not live', async () => {
        const dependencies = startupDependencies({
            resolveMode: vi.fn().mockResolvedValue({
                effectiveMode: 'paper',
                reason: 'Polygon certification evidence is not approved'
            })
        });
        await expect(verifyPolymarketEnvironment(dependencies)).resolves.toBe(false);
        expect(dependencies.getNetwork).not.toHaveBeenCalled();
        expect(dependencies.initializeClient).not.toHaveBeenCalled();
        expect(getPolymarketLiveReadiness()).toEqual({
            ready: false,
            reason: 'Polygon certification evidence is not approved'
        });
    });
    it('fails closed on a wrong chain or unavailable Polygon RPC', async () => {
        await expect(verifyPolymarketEnvironment(startupDependencies({
            getNetwork: vi.fn().mockResolvedValue({ chainId: 1 })
        }))).rejects.toThrow('Expected Polygon chain ID 137, got 1');
        expect(getPolymarketLiveReadiness().ready).toBe(false);
        await expect(verifyPolymarketEnvironment(startupDependencies({
            getNetwork: vi.fn().mockRejectedValue(new Error('Polygon RPC unavailable'))
        }))).rejects.toThrow('Polygon RPC unavailable');
        expect(getPolymarketLiveReadiness().ready).toBe(false);
    });
    it('fails closed when an official contract has no code', async () => {
        await expect(verifyPolymarketEnvironment(startupDependencies({
            getCode: vi.fn(async (address) => {
                if (address.toLowerCase() === SIGNER.toLowerCase())
                    return '0x';
                if (address.toLowerCase() === POLYMARKET_CONTRACTS.pUsd.toLowerCase())
                    return '0x';
                return '0x6000';
            })
        }))).rejects.toThrow('pUSD has no deployed bytecode');
        expect(getPolymarketLiveReadiness().ready).toBe(false);
    });
    it('fails closed when authenticated CLOB startup is unavailable', async () => {
        await expect(verifyPolymarketEnvironment(startupDependencies({
            initializeClient: vi.fn().mockRejectedValue(new Error('CLOB unavailable'))
        }))).rejects.toThrow('Polymarket verification failed: CLOB unavailable');
        expect(getPolymarketLiveReadiness().ready).toBe(false);
    });
    it('rejects an EOA identity backed by contract code', async () => {
        await expect(verifyPolymarketEnvironment(startupDependencies({
            getCode: vi.fn().mockResolvedValue('0x6000')
        }))).rejects.toThrow('EOA signature mode resolved to a contract account wallet');
    });
    it('attests the proxy path and fails when its SDK implementation has no code', async () => {
        const proxyIdentity = {
            ...eoaIdentity(),
            funderAddress: ACCOUNT_WALLET,
            signatureType: SignatureType.POLY_PROXY,
            signatureTypeName: 'POLY_PROXY',
            directWalletWritesAllowed: false
        };
        const dependencies = startupDependencies({
            initializeClient: vi.fn().mockResolvedValue(proxyIdentity),
            getCode: vi.fn(async (address) => address.toLowerCase() === POLYMARKET_CONTRACTS.proxyImplementation.toLowerCase()
                ? '0x'
                : '0x6000')
        });
        await expect(verifyPolymarketEnvironment(dependencies)).rejects.toThrow('Polymarket Proxy implementation has no deployed bytecode');
        expect(dependencies.createCollateralGateway).not.toHaveBeenCalled();
    });
    it('fails if the authenticated CLOB balance cannot support the live minimum', async () => {
        await expect(verifyPolymarketEnvironment(startupDependencies({
            getAuthenticatedCollateralBalance: vi.fn().mockResolvedValue(0.5)
        }))).rejects.toThrow('Authenticated CLOB collateral balance is below');
        expect(getPolymarketLiveReadiness().ready).toBe(false);
    });
    it('revokes readiness before resolving database execution policy', async () => {
        setPolymarketLiveReadiness(true);
        await expect(verifyPolymarketEnvironment(startupDependencies({
            resolveMode: vi.fn().mockRejectedValue(new Error('database unavailable'))
        }))).rejects.toThrow('Polymarket verification failed: database unavailable');
        expect(getPolymarketLiveReadiness()).toEqual({
            ready: false,
            reason: 'database unavailable'
        });
    });
});
//# sourceMappingURL=polymarket-startup.test.js.map