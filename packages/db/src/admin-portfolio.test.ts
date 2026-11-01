import { describe, it, expect, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  return {
    query: vi.fn(),
  };
});

vi.mock('./client.js', () => ({
  query: mocks.query,
  pool: {},
  readPool: {},
  writePool: {},
}));

import {
  getAdminPortfolioOverview,
  getAdminPortfolioUsers,
  getAdminPortfolioUserDetail,
  getAdminPortfolioMasters,
  getAdminPortfolioTokens,
  getAdminPortfolioExportData,
} from './admin-portfolio.js';

describe('admin-portfolio db queries', () => {
  it('getAdminPortfolioOverview returns calculated totals and win rate', async () => {
    const mockClient: any = {
      query: vi.fn().mockImplementation((sql: string) => {
        if (sql.includes('cash_float')) {
          return Promise.resolve({
            rows: [
              {
                cash_float: '5420.50',
                positions_value: '12500.00',
                net_realized_pnl: '1840.25',
                net_realized_pnl_24h: '320.10',
                gas_tip_burn: '45.12',
                active_copiers: '12',
                open_positions_count: '28',
              },
            ],
          });
        }
        if (sql.includes('total_sells')) {
          return Promise.resolve({
            rows: [{ wins: '15', total_sells: '20' }],
          });
        }
        return Promise.resolve({ rows: [] });
      }),
    };

    const overview = await getAdminPortfolioOverview(mockClient);
    expect(overview.totalFleetAumUsd).toBe(17920.50);
    expect(overview.netRealizedPnlUsd).toBe(1840.25);
    expect(overview.netRealizedPnl24hUsd).toBe(320.10);
    expect(overview.fleetWinRatePct).toBe(75.0);
    expect(overview.cumulativeGasTipBurnUsd).toBe(45.12);
    expect(overview.totalCopiersActive).toBe(12);
    expect(overview.openPositionsCount).toBe(28);
  });

  it('getAdminPortfolioUsers applies pagination and enriches custody & subscriptions', async () => {
    const mockClient: any = {
      query: vi.fn().mockImplementation((sql: string) => {
        if (sql.includes('COUNT(*) AS total FROM users')) {
          return Promise.resolve({ rows: [{ total: '1' }] });
        }
        if (sql.includes('SELECT') && sql.includes('FROM users u')) {
          return Promise.resolve({
            rows: [
              {
                id: '11111111-1111-1111-1111-111111111111',
                email: 'trader@example.com',
                role: 'user',
                tier: 'operator',
                created_at: new Date('2026-08-01T00:00:00Z'),
                tier_expires_at: new Date('2026-09-01T00:00:00Z'),
                grace_period_ends_at: null,
                kill_switch_active: false,
                total_cash: '1200.00',
                open_positions_count: '3',
                open_positions_value: '2500.00',
                trades_24h: '5',
                realized_pnl: '150.00',
              },
            ],
          });
        }
        if (sql.includes('user_execution_grants')) {
          return Promise.resolve({
            rows: [
              {
                user_id: '11111111-1111-1111-1111-111111111111',
                chain: 'solana',
                grant_type: 'solana_vault',
              },
            ],
          });
        }
        if (sql.includes('user_wallet_subscriptions')) {
          return Promise.resolve({
            rows: [
              {
                user_id: '11111111-1111-1111-1111-111111111111',
                wallet_address: 'solana:7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU',
                label: 'Solana Whale Alpha',
                chain: 'solana',
                state: 'active',
                membership_slot: 4,
              },
            ],
          });
        }
        return Promise.resolve({ rows: [] });
      }),
    };

    const res = await getAdminPortfolioUsers(mockClient, { page: 1, limit: 10 });
    expect(res.total).toBe(1);
    expect(res.users.length).toBe(1);
    const u = res.users[0];
    expect(u.email).toBe('trader@example.com');
    expect(u.tier).toBe('operator');
    expect(u.custodyStatus.solana).toBe('solana_vault');
    expect(u.copiedMasters.length).toBe(1);
    expect(u.copiedMasters[0].membershipSlot).toBe(4);
    expect(u.totalCashFloatUsd).toBe(1200.0);
  });

  it('getAdminPortfolioUserDetail returns null for non-existent user and populates tabs for valid user', async () => {
    const mockClientEmpty: any = {
      query: vi.fn().mockResolvedValue({ rows: [] }),
    };
    const nullUser = await getAdminPortfolioUserDetail(mockClientEmpty, '00000000-0000-0000-0000-000000000000');
    expect(nullUser).toBeNull();

    const mockClient: any = {
      query: vi.fn().mockImplementation((sql: string) => {
        if (sql.includes('FROM users u')) {
          return Promise.resolve({
            rows: [
              {
                id: '11111111-1111-1111-1111-111111111111',
                email: 'operator@wake.trade',
                role: 'admin',
                tier: 'lifetime',
                created_at: new Date('2026-08-01T00:00:00Z'),
                tier_expires_at: null,
                grace_period_ends_at: null,
                kill_switch_active: false,
                max_slippage_bps: 50,
              },
            ],
          });
        }
        if (sql.includes('FROM user_balances')) {
          return Promise.resolve({
            rows: [
              {
                chain: 'solana',
                asset: 'solana:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
                balance_usd: '1000.00',
                balance_native: 1000,
                updated_at: new Date('2026-08-01T00:00:00Z'),
              },
            ],
          });
        }
        if (sql.includes('FROM copy_positions cp')) {
          return Promise.resolve({
            rows: [
              {
                id: '22222222-2222-2222-2222-222222222222',
                chain: 'solana',
                token_mint: 'solana:So11111111111111111111111111111111111111112',
                confirmed_quantity: '5.0',
                cost_basis_usd: '750.00',
                master_wallet_address: 'solana:MasterWallet111',
              },
            ],
          });
        }
        if (sql.includes('FROM user_wallet_subscriptions uws')) {
          return Promise.resolve({
            rows: [
              {
                wallet_address: 'solana:MasterWallet111',
                chain: 'solana',
                label: 'Top Alpha Master',
                source: 'manual',
                state: 'active',
                membership_slot: 1,
                created_at: new Date('2026-08-01T00:00:00Z'),
              },
            ],
          });
        }
        if (sql.includes('FROM copy_executions')) {
          return Promise.resolve({
            rows: [
              {
                id: '33333333-3333-3333-3333-333333333333',
                chain: 'solana',
                token_mint: 'solana:So11111111111111111111111111111111111111112',
                direction: 'buy',
                execution_mode: 'live',
                confirmed_base_quantity: '5.0',
                confirmed_quote_quantity: '750.0',
                fee_usd: '0.05',
                transaction_hash: '5Z1abc...',
                confirmed_at: new Date('2026-08-01T00:00:00Z'),
              },
            ],
          });
        }
        return Promise.resolve({ rows: [] });
      }),
    };

    const detail = await getAdminPortfolioUserDetail(mockClient, '11111111-1111-1111-1111-111111111111');
    expect(detail).not.toBeNull();
    expect(detail?.user.email).toBe('operator@wake.trade');
    expect(detail?.balances.length).toBe(1);
    expect(detail?.openPositions.length).toBe(1);
    expect(detail?.openPositions[0].costBasisUsd).toBe(750.00);
    expect(detail?.subscriptions.length).toBe(1);
    expect(detail?.executionLedger.length).toBe(1);
    expect(detail?.executionLedger[0].fillPriceUsd).toBe(150.00);
  });

  it('getAdminPortfolioMasters computes follower capacity and profitability', async () => {
    const mockClient: any = {
      query: vi.fn().mockResolvedValue({
        rows: [
          {
            master_wallet_address: 'solana:Master1',
            chain: 'solana',
            label: 'Alpha Whale',
            follower_count: '15',
            follower_capital_usd: '45000.00',
            copier_realized_pnl: '3200.50',
            winning_trades: '18',
            total_sell_trades: '24',
          },
        ],
      }),
    };

    const masters = await getAdminPortfolioMasters(mockClient);
    expect(masters.length).toBe(1);
    expect(masters[0].followerCount).toBe(15);
    expect(masters[0].followerCap).toBe(50);
    expect(masters[0].totalFollowerCapitalUsd).toBe(45000.00);
    expect(masters[0].copierRealizedPnlUsd).toBe(3200.50);
    expect(masters[0].copierWinRatePct).toBe(75.0);
  });

  it('getAdminPortfolioTokens calculates fleet exposure and concentration', async () => {
    const mockClient: any = {
      query: vi.fn().mockResolvedValue({
        rows: [
          {
            token_mint: 'solana:JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',
            chain: 'solana',
            total_holders: '8',
            total_quantity: '10000',
            total_exposure_usd: '8500.00',
          },
        ],
      }),
    };

    const tokens = await getAdminPortfolioTokens(mockClient);
    expect(tokens.length).toBe(1);
    expect(tokens[0].totalHolders).toBe(8);
    expect(tokens[0].totalExposureUsd).toBe(8500.00);
  });

  it('getAdminPortfolioExportData streams requested export slice', async () => {
    const mockClient: any = {
      query: vi.fn().mockResolvedValue({
        rows: [{ id: 'pos-1', user_id: 'u-1', token_mint: 'solana:test', cost_basis_usd: '100' }],
      }),
    };

    const positions = await getAdminPortfolioExportData(mockClient, 'positions');
    expect(positions.length).toBe(1);
    expect(positions[0].id).toBe('pos-1');
  });
});
