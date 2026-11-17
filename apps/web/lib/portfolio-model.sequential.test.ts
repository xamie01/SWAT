import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from './api.js';
import { enrollmentAllowed, submitPolymarketEnrollment, geoNotice, loadingObservation, lpActionAllowed, lpBuildNotice, lpMode, lpOperationNotice, observe, observedNumber, perpsRisk, spotTotals, submitLpAction, submitReduction, usd, type LpPositionView, type SpotPosition } from './portfolio-model.js';

const spot: SpotPosition = { id: 'position', chain: 'solana', tokenMint: 'observed-token', tokenSymbol: null, confirmedQuantity: 2, costBasisUsd: 12, currentPriceUsd: null, unrealizedPnlUsd: null, unrealizedPnlPct: null };
const lp: LpPositionView = { id: 'lp', chain: 'solana', protocol: 'meteora', poolAddress: 'solana:observed-pool', strategyType: 'spot', rangeLower: 1, rangeUpper: 2, depositAmount: 4, depositAsset: 'solana:token', depositValueUsd: null, state: 'active', autoRebalance: false, acquisitionMode: 'paper', paperPlan: { version: 1 }, onChainPositionAddress: null };

describe('truthful portfolio presentation and handler guards', () => {
  it('distinguishes loading, API failure and observed empty without inventing holdings', async () => {
    expect(loadingObservation()).toEqual({ state: 'loading', data: null, error: null });
    const failed = await observe(async () => { throw new ApiError(503, 'storage unavailable'); }, 'Positions unavailable');
    expect(failed.state).toBe('unavailable'); expect(failed.data).toBeNull();
    expect(failed.error).toContain('HTTP 503'); expect(JSON.stringify(failed)).not.toMatch(/WSOL|HOOD|positions/);
    const empty = await observe(async () => ({ positions: [] }), 'Unavailable');
    expect(empty).toEqual({ state: 'observed', data: { positions: [] }, error: null });
    expect(spotTotals(failed.data)).toEqual({ value: null, cost: null, pnl: null });
    expect(spotTotals(empty.data?.positions ?? null)).toEqual({ value: 0, cost: 0, pnl: 0 });
  });
  it('uses session-specific API errors rather than replacing them with empty data', async () => {
    const failure = await observe(async () => { throw new ApiError(401, 'expired'); }, 'Unavailable');
    expect(failure.error).toContain('sign in again'); expect(failure.data).toBeNull();
  });
  it('null mark and PnL remain unassessed; one unvalued row invalidates the aggregate', () => {
    expect(spotTotals([spot])).toEqual({ value: null, cost: 12, pnl: null });
    expect(spotTotals([{ ...spot, currentPriceUsd: 10, unrealizedPnlUsd: 8 }, spot])).toEqual({ value: null, cost: 24, pnl: null });
    expect(usd(null)).toBe('Unassessed');
  });
  it.each([null, undefined, '', ' ', 'NaN', 'Infinity', NaN, Infinity])('refuses missing/nonfinite number %s', value => {
    expect(observedNumber(value)).toBeNull(); expect(usd(value)).toBe('Unassessed');
  });
  it('never derives safe margin from missing account or zero equity', () => {
    expect(perpsRisk(null)).toEqual({ equity: null, maintenance: null, available: null, ratio: null, liquidation: null });
    expect(perpsRisk({ total_account_value: '0', available_order_margin: '0', total_maintenance_margin: '0', in_liquidation: null }).ratio).toBeNull();
    expect(perpsRisk({ total_account_value: '100', available_order_margin: '', total_maintenance_margin: '20', in_liquidation: true })).toEqual({ equity: 100, maintenance: 20, available: null, ratio: 20, liquidation: true });
  });
  it('refuses unsupported reducing actions in the handler before transport', async () => {
    const post = vi.fn().mockResolvedValue({ success: true });
    await expect(submitReduction(post)).rejects.toMatchObject({ status: 503 }); expect(post).not.toHaveBeenCalled();
  });
  it.each(['unknown', 'live', undefined] as const)('does not infer paper/live authority for acquisition mode %s', async mode => {
    const position = { ...lp, acquisitionMode: mode };
    expect(lpMode(position)).toContain(mode === 'live' ? 'Live acquisition' : 'unknown');
    const post = vi.fn();
    for (const kind of ['close', 'rebalance', 'auto-rebalance'] as const) {
      expect(lpActionAllowed(position, kind)).toBe(false);
      await expect(submitLpAction(position, kind, post)).rejects.toMatchObject({ status: 503 });
    }
    expect(post).not.toHaveBeenCalled();
  });
  it('guards missing paper evidence, on-chain exposure and terminal/pending states', () => {
    for (const position of [{ ...lp, paperPlan: null }, { ...lp, onChainPositionAddress: 'on-chain' }, { ...lp, state: 'closed' }]) expect(lpActionAllowed(position, 'close')).toBe(false);
    expect(lpActionAllowed({ ...lp, state: 'rebalancing' }, 'rebalance')).toBe(false);
    expect(lpActionAllowed(lp, 'close')).toBe(true);
  });
  it('separates token quantity from nullable USD valuation and never claims live paper closure', () => {
    expect(lp.depositAmount).toBe(4); expect(usd(lp.depositValueUsd)).toBe('Unassessed');
    expect(lpOperationNotice({ broadcast: false, queued: false, operation: { positionId: 'lp', kind: 'close', status: 'completed' } }, 'close', 'lp')).toBe('Paper operation completed locally. No live liquidity was moved.');
    expect(lpOperationNotice({ broadcast: false, queued: false, operation: { positionId: 'lp', kind: 'rebalance', status: 'pending' } }, 'rebalance', 'lp')).toContain('queue delivery is unconfirmed');
    expect(lpOperationNotice({ success: true }, 'close', 'lp')).toContain('unverified');
    expect(lpBuildNotice({ mode: 'paper', positionId: 'lp', rejectionReasons: [] })).toContain('No live liquidity was deployed');
    expect(lpBuildNotice({ mode: 'live', positionId: 'lp', rejectionReasons: [] })).toContain('unverified');
  });
  it.each([null, undefined, {}, { enrollmentSupported: false }, { enrollmentSupported: true }])('refuses enrollment before wallet connection, challenge and signing for %j', async capability => {
    const connect = vi.fn(), challenge = vi.fn(), sign = vi.fn(), enroll = vi.fn(async () => { connect(); challenge(); sign(); });
    expect(enrollmentAllowed(capability)).toBe(false);
    await expect(submitPolymarketEnrollment(capability, enroll)).rejects.toMatchObject({ status: 503 });
    expect(enroll).not.toHaveBeenCalled(); expect(connect).not.toHaveBeenCalled(); expect(challenge).not.toHaveBeenCalled(); expect(sign).not.toHaveBeenCalled();
  });
  it('binds enrollment guard and disabled label without automatic Polygon enrollment', () => {
    const page = readFileSync('apps/web/app/vault/page.tsx', 'utf8');
    expect(page).toContain('polymarket: PolymarketEnrollmentView & {');
    expect(page).toContain('submitPolymarketEnrollment(data?.polymarket');
    expect(page).toContain('!enrollmentAllowed(data?.polymarket)');
    expect(page).toContain('Polymarket enrollment unavailable');
    expect(page).not.toMatch(/signPolymarketClobAuth|\/vault\/polymarket\/(challenge|credentials)|You can authorize Polymarket/);
  });
  it('uses only the genuine AppKit WalletConnect component, without static QR/URI or implicit authority grant', () => {
    const page = readFileSync('apps/web/app/vault/page.tsx', 'utf8');
    const component = readFileSync('apps/web/components/WalletConnectModalButton.tsx', 'utf8');
    expect(page).toContain('<WalletConnectModalButton');
    expect(page).not.toMatch(/showWalletConnectModal|Visual QR Pattern|wc:7f83|Copy Connection URI/);
    expect(component).toContain('await open()');
    expect(component).not.toContain('/v1/me/vault/grant');
  });
  it('LP builder has no hardcoded yield, custody ownership or dollar-valued token presets', () => {
    const page = readFileSync('apps/web/app/lp/builder/page.tsx', 'utf8');
    expect(page).toContain('Unassessed — no yield forecast');
    expect(page).toContain('{preset} units');
    expect(page).toContain('no position NFT, DLMM key, deployed vault or live custody ownership is established');
    expect(page).not.toMatch(/184\.2|\$\{preset\}|remain under sole ownership/);
  });
  it('does not convert unassessed geo eligibility into approval', () => {
    expect(geoNotice(null)).toBe('Unassessed'); expect(geoNotice(undefined)).toBe('Unassessed'); expect(geoNotice(false)).toBe('Not eligible');
  });
});
