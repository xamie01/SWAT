import { describe, expect, it } from 'vitest';
import { requirePolymarketSignalContext } from './polymarket-context.js';

const TOKEN_ID = `polygon:${'1'.repeat(40)}`;
const context = {
  tokenId: TOKEN_ID,
  conditionId: `0x${'a'.repeat(64)}`,
  outcome: 'Yes',
  outcomeIndex: 0,
  question: 'Will the fixture pass?',
  slug: 'fixture-pass',
  endDate: new Date('2026-08-01T00:00:00Z'),
  marketStatus: 'active',
  tickSize: '0.01',
  negRisk: false,
  acceptingOrders: true,
  resolutionStatus: 'unresolved',
  contextComplete: true
};

describe('Polymarket signal context', () => {
  it('includes every required market field', () => {
    expect(requirePolymarketSignalContext(context, TOKEN_ID)).toEqual({
      tokenName: 'Will the fixture pass?',
      tokenSymbol: 'YES',
      triggerData: {
        pmConditionId: context.conditionId,
        pmQuestion: context.question,
        pmOutcome: context.outcome,
        pmEndDate: '2026-08-01T00:00:00.000Z',
        pmState: 'active',
        pmTickSize: '0.01',
        pmNegRisk: false,
        pmAcceptingOrders: true,
        pmResolutionStatus: 'unresolved'
      }
    });
  });

  it('fails closed for missing or incomplete context', () => {
    expect(() => requirePolymarketSignalContext(null, TOKEN_ID)).toThrow(/Missing complete/);
    expect(() => requirePolymarketSignalContext({
      ...context,
      contextComplete: false
    }, TOKEN_ID)).toThrow(/Missing complete/);
    expect(() => requirePolymarketSignalContext({
      ...context,
      question: ''
    }, TOKEN_ID)).toThrow(/Incomplete/);
  });
});
