import { describe, expect, it, vi } from 'vitest';
import {
  ensurePolymarketCollateralReadiness,
  POLYMARKET_CONTRACTS,
  type PolymarketCollateralGateway
} from './polymarket-collateral.js';

function createGateway(
  overrides: Partial<PolymarketCollateralGateway> = {}
): PolymarketCollateralGateway {
  return {
    getPusdDecimals: vi.fn().mockResolvedValue(6),
    getUsdcEDecimals: vi.fn().mockResolvedValue(6),
    getPusdBalance: vi.fn().mockResolvedValue(10_000_000n),
    getUsdcEBalance: vi.fn().mockResolvedValue(0n),
    getUsdcEAllowance: vi.fn().mockResolvedValue(0n),
    approveUsdcE: vi.fn().mockResolvedValue('0x-usdce-approve'),
    wrapUsdcE: vi.fn().mockResolvedValue('0x-wrap'),
    getPusdAllowance: vi.fn().mockResolvedValue(10_000_000n),
    approvePusd: vi.fn().mockResolvedValue('0x-pusd-approve'),
    isConditionalTokenApproved: vi.fn().mockResolvedValue(true),
    approveConditionalTokenOperator: vi.fn().mockResolvedValue('0x-conditional-approve'),
    ...overrides
  };
}

const baseOptions = {
  funderAddress: '0x1111111111111111111111111111111111111111',
  signerAddress: '0x1111111111111111111111111111111111111111',
  accountWalletType: 'EOA' as const,
  directWalletWritesAllowed: true,
  minimumPusdUnits: 1_000_000n,
  allowanceCapUnits: 10_000_000n,
  autoOnramp: false,
  autoApprove: false
};

describe('Polymarket collateral readiness', () => {
  it('accepts the exact minimum balance, exact exchange caps, and sell approvals', async () => {
    const gateway = createGateway({
      getPusdBalance: vi.fn().mockResolvedValue(baseOptions.minimumPusdUnits)
    });

    const result = await ensurePolymarketCollateralReadiness(gateway, baseOptions);

    expect(result.pUsdBalanceUnits).toBe(baseOptions.minimumPusdUnits);
    expect(result.allowanceCapUnits).toBe(baseOptions.allowanceCapUnits);
    expect(result.actions).toEqual([]);
    expect(gateway.getPusdAllowance).toHaveBeenCalledTimes(2);
    expect(gateway.isConditionalTokenApproved).toHaveBeenCalledTimes(2);
    expect(gateway.approvePusd).not.toHaveBeenCalled();
  });

  it('onramps only the exact deficit and installs bounded EOA approvals', async () => {
    let pUsdBalance = 0n;
    let usdcEAllowance = 0n;
    const pUsdAllowances = new Map<string, bigint>();
    const conditionalApprovals = new Set<string>();
    const approveUsdcE = vi.fn(async (_spender: string, amount: bigint) => {
      usdcEAllowance = amount;
      return `0x-usdce-${amount}`;
    });
    const approvePusd = vi.fn(async (spender: string, amount: bigint) => {
      pUsdAllowances.set(spender, amount);
      return `0x-pusd-${spender.slice(-4)}-${amount}`;
    });
    const approveConditionalTokenOperator = vi.fn(async (operator: string) => {
      conditionalApprovals.add(operator);
      return `0x-ctf-${operator.slice(-4)}`;
    });
    const gateway = createGateway({
      getPusdBalance: vi.fn(async () => pUsdBalance),
      getUsdcEBalance: vi.fn().mockResolvedValue(5_000_000n),
      getUsdcEAllowance: vi.fn(async () => usdcEAllowance),
      approveUsdcE,
      wrapUsdcE: vi.fn(async (_to, amount) => {
        pUsdBalance += amount;
        usdcEAllowance -= amount;
        return '0x-wrap';
      }),
      getPusdAllowance: vi.fn(async (_account, spender) => pUsdAllowances.get(spender) ?? 0n),
      approvePusd,
      isConditionalTokenApproved: vi.fn(
        async (_account, operator) => conditionalApprovals.has(operator)
      ),
      approveConditionalTokenOperator
    });

    const result = await ensurePolymarketCollateralReadiness(gateway, {
      ...baseOptions,
      autoOnramp: true,
      autoApprove: true
    });

    expect(approveUsdcE).toHaveBeenCalledWith(
      POLYMARKET_CONTRACTS.collateralOnramp,
      1_000_000n
    );
    expect(gateway.wrapUsdcE).toHaveBeenCalledWith(baseOptions.funderAddress, 1_000_000n);
    expect(approvePusd).toHaveBeenCalledTimes(2);
    expect(approvePusd.mock.calls.map((call) => call[1])).toEqual([
      baseOptions.allowanceCapUnits,
      baseOptions.allowanceCapUnits
    ]);
    expect(approveConditionalTokenOperator).toHaveBeenCalledTimes(2);
    expect(result.pUsdBalanceUnits).toBe(1_000_000n);
    expect(result.actions).toHaveLength(6);
  });

  it('reduces unlimited existing allowances to the exact configured cap', async () => {
    const allowances = new Map<string, bigint>([
      [POLYMARKET_CONTRACTS.ctfExchange, ethersMaxUint256()],
      [POLYMARKET_CONTRACTS.negRiskCtfExchange, ethersMaxUint256()]
    ]);
    const approvePusd = vi.fn(async (spender: string, amount: bigint) => {
      allowances.set(spender, amount);
      return `0x-${amount}`;
    });
    const gateway = createGateway({
      getPusdAllowance: vi.fn(async (_account, spender) => allowances.get(spender) ?? 0n),
      approvePusd
    });

    const result = await ensurePolymarketCollateralReadiness(gateway, {
      ...baseOptions,
      autoApprove: true
    });

    expect(approvePusd.mock.calls.map((call) => call[1])).toEqual([
      0n,
      baseOptions.allowanceCapUnits,
      0n,
      baseOptions.allowanceCapUnits
    ]);
    expect(approvePusd.mock.calls.flat().includes(ethersMaxUint256())).toBe(false);
    expect(result.actions.map((action) => action.type)).toEqual([
      'approve-pusd-exchange-reset',
      'approve-pusd-exchange',
      'approve-pusd-exchange-reset',
      'approve-pusd-exchange'
    ]);
  });

  it('fails closed on over-cap allowance when automatic approval is not opted in', async () => {
    const gateway = createGateway({
      getPusdAllowance: vi.fn().mockResolvedValue(baseOptions.allowanceCapUnits + 1n)
    });

    await expect(ensurePolymarketCollateralReadiness(gateway, baseOptions)).rejects.toThrow(
      'above the configured exact cap'
    );
    expect(gateway.approvePusd).not.toHaveBeenCalled();
  });

  it('fails if an approval transaction does not confirm the exact allowance', async () => {
    const gateway = createGateway({
      getPusdAllowance: vi.fn().mockResolvedValue(0n)
    });

    await expect(ensurePolymarketCollateralReadiness(gateway, {
      ...baseOptions,
      autoApprove: true
    })).rejects.toThrow('did not confirm at the configured exact cap');
  });

  it('rejects wrong collateral decimals before reading balances', async () => {
    const gateway = createGateway({
      getPusdDecimals: vi.fn().mockResolvedValue(18)
    });

    await expect(ensurePolymarketCollateralReadiness(gateway, baseOptions)).rejects.toThrow(
      'pUSD decimals mismatch'
    );
    expect(gateway.getPusdBalance).not.toHaveBeenCalled();
  });

  it('fails closed below the balance minimum and at an uncovered onramp deficit', async () => {
    const gateway = createGateway({
      getPusdBalance: vi.fn().mockResolvedValue(baseOptions.minimumPusdUnits - 1n)
    });
    await expect(ensurePolymarketCollateralReadiness(gateway, baseOptions)).rejects.toThrow(
      'explicitly enable POLYMARKET_AUTO_ONRAMP=true'
    );

    const insufficientUsdc = createGateway({
      getPusdBalance: vi.fn().mockResolvedValue(0n),
      getUsdcEBalance: vi.fn().mockResolvedValue(baseOptions.minimumPusdUnits - 1n)
    });
    await expect(ensurePolymarketCollateralReadiness(insufficientUsdc, {
      ...baseOptions,
      autoOnramp: true
    })).rejects.toThrow('cannot cover the exact pUSD onramp amount');
    expect(insufficientUsdc.approveUsdcE).not.toHaveBeenCalled();
  });

  it('rejects an automatic proxy setup before any wallet call', async () => {
    const gateway = createGateway();

    await expect(ensurePolymarketCollateralReadiness(gateway, {
      ...baseOptions,
      funderAddress: '0x2222222222222222222222222222222222222222',
      accountWalletType: 'POLY_PROXY',
      directWalletWritesAllowed: false,
      autoApprove: true
    })).rejects.toThrow('automatic setup is EOA-only');
    expect(gateway.getPusdBalance).not.toHaveBeenCalled();
    expect(gateway.approvePusd).not.toHaveBeenCalled();
  });

  it('reports actionable Safe and deposit-wallet manual readiness', async () => {
    const safeGateway = createGateway({
      getPusdAllowance: vi.fn().mockResolvedValue(0n)
    });
    await expect(ensurePolymarketCollateralReadiness(safeGateway, {
      ...baseOptions,
      funderAddress: '0x2222222222222222222222222222222222222222',
      accountWalletType: 'POLY_GNOSIS_SAFE',
      directWalletWritesAllowed: false
    })).rejects.toThrow('complete it through that account wallet rather than signer');
    expect(safeGateway.approvePusd).not.toHaveBeenCalled();

    const depositWalletGateway = createGateway({
      getPusdBalance: vi.fn().mockResolvedValue(0n)
    });
    await expect(ensurePolymarketCollateralReadiness(depositWalletGateway, {
      ...baseOptions,
      funderAddress: '0x3333333333333333333333333333333333333333',
      accountWalletType: 'POLY_1271',
      directWalletWritesAllowed: false
    })).rejects.toThrow('manual pUSD funding');
    expect(depositWalletGateway.wrapUsdcE).not.toHaveBeenCalled();
  });

  it('rejects unbounded minimum configuration', async () => {
    await expect(ensurePolymarketCollateralReadiness(createGateway(), {
      ...baseOptions,
      minimumPusdUnits: baseOptions.allowanceCapUnits + 1n
    })).rejects.toThrow('cannot exceed the bounded allowanceCapUnits');
  });
});

function ethersMaxUint256(): bigint {
  return (1n << 256n) - 1n;
}
