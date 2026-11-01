import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  activateAllChainEmergencyOff,
  clearExecutionConfigCache,
  resolveChainMode,
  setChainExecutionMode
} from './execution-config.js';
import { query } from './client.js';
import { getActiveCertifiedChains } from './chain-certifications.js';

vi.mock('./client.js', () => ({ query: vi.fn() }));
vi.mock('./chain-certifications.js', () => ({ getActiveCertifiedChains: vi.fn() }));

describe('execution configuration', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.TRADING_MODE;
    delete process.env.TRADING_MODE_SOLANA;
    delete process.env.TRADING_MODE_POLYGON;
    delete process.env.TRADING_MODE_ROBINHOOD_CHAIN;
    delete process.env.LIVE_ENABLED_CHAINS;
    vi.resetAllMocks();
    clearExecutionConfigCache();
    vi.mocked(getActiveCertifiedChains).mockResolvedValue([]);
  });

  afterEach(() => {
    vi.useRealTimers();
    process.env = originalEnv;
  });

  it('defaults to paper when nothing is configured', async () => {
    vi.mocked(query).mockResolvedValue([]);

    await expect(resolveChainMode('solana')).resolves.toMatchObject({
      requestedMode: 'paper',
      effectiveMode: 'paper'
    });
  });

  it('uses DB, chain environment, legacy environment, then paper precedence', async () => {
    vi.mocked(query).mockResolvedValue([{ value: { solana: 'live' } }]);
    process.env.TRADING_MODE_SOLANA = 'paper';
    process.env.TRADING_MODE_POLYGON = 'off';
    process.env.TRADING_MODE = 'live+shadow';
    process.env.LIVE_ENABLED_CHAINS = 'solana';
    vi.mocked(getActiveCertifiedChains).mockResolvedValue(['solana']);

    const [solana, polygon, robinhood] = await Promise.all([
      resolveChainMode('solana'),
      resolveChainMode('polygon'),
      resolveChainMode('robinhood-chain')
    ]);

    expect(solana).toMatchObject({ requestedMode: 'live', effectiveMode: 'live' });
    expect(polygon).toMatchObject({ requestedMode: 'off', effectiveMode: 'off' });
    expect(robinhood).toMatchObject({ requestedMode: 'live+shadow', effectiveMode: 'paper' });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('clamps live when the operator allowlist is absent', async () => {
    vi.mocked(query).mockResolvedValue([{ value: { 'robinhood-chain': 'live' } }]);
    vi.mocked(getActiveCertifiedChains).mockResolvedValue(['robinhood-chain']);

    await expect(resolveChainMode('robinhood-chain')).resolves.toMatchObject({
      requestedMode: 'live',
      effectiveMode: 'paper',
      certified: false,
      reason: expect.stringMatching(/not enabled in LIVE_ENABLED_CHAINS/)
    });
  });

  it('clamps live when reviewed certification evidence is absent', async () => {
    vi.mocked(query).mockResolvedValue([{ value: { polygon: 'live' } }]);
    process.env.LIVE_ENABLED_CHAINS = 'polygon';

    await expect(resolveChainMode('polygon')).resolves.toMatchObject({
      requestedMode: 'live',
      effectiveMode: 'paper',
      certified: false,
      reason: expect.stringMatching(/no active reviewed certification record/)
    });
  });

  it('keeps live modes only when operator opt-in and reviewed evidence agree', async () => {
    vi.mocked(query).mockResolvedValue([{ value: { solana: 'live+shadow' } }]);
    process.env.LIVE_ENABLED_CHAINS = 'solana';
    vi.mocked(getActiveCertifiedChains).mockResolvedValue(['solana']);

    await expect(resolveChainMode('solana')).resolves.toEqual({
      requestedMode: 'live+shadow',
      effectiveMode: 'live+shadow',
      certified: true
    });
  });

  it.each([
    null,
    [],
    'paper',
    { solana: 'LIVE' },
    { solana: 'unknown' },
    { dogecoin: 'off' },
    { '*': 'live' }
  ])('fails malformed DB configuration closed to paper: %j', async (value) => {
    vi.mocked(query).mockResolvedValue([{ value }]);
    process.env.TRADING_MODE_SOLANA = 'live';
    process.env.LIVE_ENABLED_CHAINS = 'solana';
    vi.mocked(getActiveCertifiedChains).mockResolvedValue(['solana']);

    await expect(resolveChainMode('solana')).resolves.toMatchObject({
      requestedMode: 'paper',
      effectiveMode: 'paper',
      reason: expect.stringMatching(/invalid; fail-closed to paper/)
    });
  });

  it('caches present and absent DB configuration for no longer than 30 seconds', async () => {
    vi.useFakeTimers();
    vi.mocked(query)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ value: { solana: 'off' } }]);

    await expect(resolveChainMode('solana')).resolves.toMatchObject({ requestedMode: 'paper' });
    vi.advanceTimersByTime(29_999);
    await expect(resolveChainMode('solana')).resolves.toMatchObject({ requestedMode: 'paper' });
    expect(query).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1);
    await expect(resolveChainMode('solana')).resolves.toMatchObject({ requestedMode: 'off' });
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('invalidates the local cache immediately after a hot chain change', async () => {
    vi.mocked(query)
      .mockResolvedValueOnce([{ value: { solana: 'paper' } }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ value: { solana: 'off' } }]);

    await expect(resolveChainMode('solana')).resolves.toMatchObject({ requestedMode: 'paper' });
    await setChainExecutionMode('solana', 'off');
    await expect(resolveChainMode('solana')).resolves.toMatchObject({ requestedMode: 'off' });

    expect(query).toHaveBeenCalledTimes(3);
    expect(vi.mocked(query).mock.calls[1]?.[1]).toEqual(['solana', 'off']);
  });

  it('does not let a stale in-flight read repopulate the cache after a hot change', async () => {
    let finishStaleLoad: ((rows: { value: { solana: string } }[]) => void) | undefined;
    vi.mocked(query)
      .mockImplementationOnce(() => new Promise((resolve) => {
        finishStaleLoad = resolve;
      }))
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ value: { solana: 'off' } }]);

    const staleResolution = resolveChainMode('solana');
    await setChainExecutionMode('solana', 'off');
    finishStaleLoad?.([{ value: { solana: 'paper' } }]);
    await expect(staleResolution).resolves.toMatchObject({ requestedMode: 'paper' });

    await expect(resolveChainMode('solana')).resolves.toMatchObject({ requestedMode: 'off' });
    expect(query).toHaveBeenCalledTimes(3);
  });

  it('resolves concurrent chains independently while sharing one config load', async () => {
    let finishLoad: ((rows: { value: Record<string, string> }[]) => void) | undefined;
    vi.mocked(query).mockImplementationOnce(() => new Promise((resolve) => {
      finishLoad = resolve;
    }));
    process.env.LIVE_ENABLED_CHAINS = 'solana,robinhood-chain';
    vi.mocked(getActiveCertifiedChains).mockResolvedValue(['solana', 'robinhood-chain']);

    const resolutions = Promise.all([
      resolveChainMode('solana'),
      resolveChainMode('polygon'),
      resolveChainMode('robinhood-chain')
    ]);
    finishLoad?.([{
      value: { solana: 'live+shadow', polygon: 'paper', 'robinhood-chain': 'live' }
    }]);

    const [solana, polygon, robinhood] = await resolutions;
    expect(solana.effectiveMode).toBe('live+shadow');
    expect(polygon.effectiveMode).toBe('paper');
    expect(robinhood.effectiveMode).toBe('live');
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('stores the all-chain emergency switch atomically as {"*":"off"}', async () => {
    vi.mocked(query).mockResolvedValue([]);

    await activateAllChainEmergencyOff();

    expect(query).toHaveBeenCalledTimes(1);
    expect(vi.mocked(query).mock.calls[0]?.[1]).toEqual(['*', 'off']);
    expect(vi.mocked(query).mock.calls[0]?.[0]).toContain('value = EXCLUDED.value');
  });

  it('keeps per-chain requested modes visible while global off controls every effective mode', async () => {
    vi.mocked(query).mockResolvedValue([{
      value: { solana: 'live+shadow', polygon: 'paper', '*': 'off' }
    }]);
    process.env.TRADING_MODE_ROBINHOOD_CHAIN = 'live';

    const [solana, polygon, robinhood] = await Promise.all([
      resolveChainMode('solana'),
      resolveChainMode('polygon'),
      resolveChainMode('robinhood-chain')
    ]);

    expect(solana).toMatchObject({ requestedMode: 'live+shadow', effectiveMode: 'off' });
    expect(polygon).toMatchObject({ requestedMode: 'paper', effectiveMode: 'off' });
    expect(robinhood).toMatchObject({ requestedMode: 'live', effectiveMode: 'off' });
    expect([solana.reason, polygon.reason, robinhood.reason]).toEqual([
      'Global kill switch active (*)',
      'Global kill switch active (*)',
      'Global kill switch active (*)'
    ]);
  });
});
