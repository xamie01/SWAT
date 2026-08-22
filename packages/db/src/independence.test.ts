import { describe, expect, it } from 'vitest';

import {
  HUB_FUNDER_LABELS,
  InvalidFunderIndependencePolicyError,
  MAX_FUNDER_DEGREE,
  MIN_FUNDED_WALLETS,
  admitsFundingCluster,
  assessFunderIndependence,
  partitionFundersByIndependence
} from './independence.js';
import type { FunderIndependenceInput, FunderLabel } from './independence.js';

// No ./client.js import anywhere in the module under test, so this suite needs no
// DATABASE_URL and no vi.hoisted mock. That is the point of keeping the predicate
// pure -- it is the only part of S4-M11 that can be tested without a database.

const FUNDER = 'solana:FundErAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

function input(overrides: Partial<FunderIndependenceInput> = {}): FunderIndependenceInput {
  return { funder: FUNDER, observedFundedWalletCount: 3, label: null, ...overrides };
}

describe('degree band', () => {
  it('clears a person-scale funder inside the band', () => {
    const result = assessFunderIndependence(input({ observedFundedWalletCount: 3 }));
    expect(result.verdict).toBe('independent');
    expect(result.code).toBe('degree-within-cap');
    expect(admitsFundingCluster(result)).toBe(true);
  });

  it('clears a funder sitting exactly on the ceiling', () => {
    const result = assessFunderIndependence(
      input({ observedFundedWalletCount: MAX_FUNDER_DEGREE })
    );
    expect(result.verdict).toBe('independent');
  });

  it('rejects one wallet over the ceiling', () => {
    const result = assessFunderIndependence(
      input({ observedFundedWalletCount: MAX_FUNDER_DEGREE + 1 })
    );
    expect(result.verdict).toBe('hub');
    expect(result.code).toBe('degree-exceeds-cap');
    expect(admitsFundingCluster(result)).toBe(false);
  });

  it('rejects a CEX-scale funder -- the bug this exists for', () => {
    const result = assessFunderIndependence(input({ observedFundedWalletCount: 2_400_000 }));
    expect(result.verdict).toBe('hub');
    expect(result.code).toBe('degree-exceeds-cap');
    expect(result.message).toContain('2400000');
  });

  it('keeps below-minimum separate from hub', () => {
    const result = assessFunderIndependence(
      input({ observedFundedWalletCount: MIN_FUNDED_WALLETS - 1 })
    );
    expect(result.verdict).toBe('below-minimum');
    expect(result.code).toBe('degree-below-minimum');
    expect(admitsFundingCluster(result)).toBe(false);
  });

  it('carries the applied bound on the result so a log line is self-describing', () => {
    const result = assessFunderIndependence(input(), { maxFunderDegree: 9 });
    expect(result.maxFunderDegree).toBe(9);
    expect(result.minFundedWallets).toBe(MIN_FUNDED_WALLETS);
  });

  it('honours an overridden ceiling', () => {
    expect(
      assessFunderIndependence(input({ observedFundedWalletCount: 10 }), {
        maxFunderDegree: 5
      }).code
    ).toBe('degree-exceeds-cap');
  });
});

describe('unknown degree is not a cleared funder', () => {
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['fractional', 2.5],
    ['negative', -1]
  ])('treats a %s count as unassessed, never independent', (_label, value) => {
    const result = assessFunderIndependence(
      input({ observedFundedWalletCount: value as number | null })
    );
    expect(result.verdict).toBe('unassessed');
    expect(result.code).toBe('degree-unknown');
    expect(result.observedFundedWalletCount).toBeNull();
    expect(admitsFundingCluster(result)).toBe(false);
  });

  it('does not read a missing count as zero', () => {
    // Zero would be "below-minimum" -- a positive claim about a funder we never
    // counted. It must not be reachable from an absent count.
    const result = assessFunderIndependence({ funder: FUNDER, label: null });
    expect(result.code).not.toBe('degree-below-minimum');
    expect(result.code).toBe('degree-unknown');
  });

  it('counts a genuine zero as below-minimum, not unknown', () => {
    expect(assessFunderIndependence(input({ observedFundedWalletCount: 0 })).code).toBe(
      'degree-below-minimum'
    );
  });
});

describe('hub exclusion is independent of observed degree', () => {
  it.each(HUB_FUNDER_LABELS.map((label) => [label] as const))(
    'rejects a %s label even at a tiny observed degree',
    (label) => {
      // The whole reason a degree cap alone is insufficient: observed degree is
      // degree within OUR index. An exchange whose other million recipients we do
      // not track looks like a three-wallet funder.
      const result = assessFunderIndependence(
        input({ observedFundedWalletCount: 3, label })
      );
      expect(result.verdict).toBe('hub');
      expect(result.code).toBe('labelled-hub');
    }
  );

  it('rejects a hub label even when the degree is unknown', () => {
    const result = assessFunderIndependence(
      input({ observedFundedWalletCount: null, label: 'exchange' })
    );
    expect(result.verdict).toBe('hub');
    expect(result.code).toBe('labelled-hub');
    expect(result.message).toContain('unknown');
  });

  it('does not reject the individual label', () => {
    expect(assessFunderIndependence(input({ label: 'individual' })).verdict).toBe(
      'independent'
    );
  });

  it('honours an overridden hub-label set', () => {
    expect(
      assessFunderIndependence(input({ label: 'individual' }), {
        hubLabels: ['individual']
      }).code
    ).toBe('labelled-hub');
    expect(
      assessFunderIndependence(input({ label: 'exchange' }), { hubLabels: [] }).verdict
    ).toBe('independent');
  });
});

describe('an unchecked label is not a clean label', () => {
  it('is unassessed when no label lookup happened, even at a fine degree', () => {
    const result = assessFunderIndependence({
      funder: FUNDER,
      observedFundedWalletCount: 3
    });
    expect(result.labelChecked).toBe(false);
    expect(result.verdict).toBe('unassessed');
    expect(result.code).toBe('hub-label-unchecked');
    expect(admitsFundingCluster(result)).toBe(false);
  });

  it('distinguishes an explicit null (looked up, nothing found) from absent', () => {
    const checked = assessFunderIndependence({
      funder: FUNDER,
      observedFundedWalletCount: 3,
      label: null
    });
    expect(checked.labelChecked).toBe(true);
    expect(checked.verdict).toBe('independent');

    const unchecked = assessFunderIndependence({
      funder: FUNDER,
      observedFundedWalletCount: 3
    });
    expect(unchecked.labelChecked).toBe(false);
    expect(unchecked.verdict).toBe('unassessed');
  });

  it('reports the degree failure ahead of the missing label', () => {
    // Over the cap is decidable without any label, so it is not downgraded to
    // "cannot tell" just because the label was never fetched.
    const result = assessFunderIndependence({
      funder: FUNDER,
      observedFundedWalletCount: 5_000
    });
    expect(result.verdict).toBe('hub');
    expect(result.code).toBe('degree-exceeds-cap');
  });

  it('reports below-minimum ahead of the missing label', () => {
    const result = assessFunderIndependence({ funder: FUNDER, observedFundedWalletCount: 1 });
    expect(result.verdict).toBe('below-minimum');
  });
});

describe('policy validation fails loud', () => {
  it.each([
    [{ minFundedWallets: 0 }],
    [{ minFundedWallets: 1.5 }],
    [{ minFundedWallets: -3 }]
  ])('rejects an incoherent minimum %j', (policy) => {
    expect(() => assessFunderIndependence(input(), policy)).toThrow(
      InvalidFunderIndependencePolicyError
    );
  });

  it('rejects a ceiling under the floor, which would admit nothing', () => {
    expect(() =>
      assessFunderIndependence(input(), { minFundedWallets: 5, maxFunderDegree: 4 })
    ).toThrow(InvalidFunderIndependencePolicyError);
  });

  it('rejects a fractional ceiling', () => {
    expect(() => assessFunderIndependence(input(), { maxFunderDegree: 7.5 })).toThrow(
      InvalidFunderIndependencePolicyError
    );
  });

  it('accepts a ceiling equal to the floor', () => {
    expect(
      assessFunderIndependence(input({ observedFundedWalletCount: 2 }), {
        minFundedWallets: 2,
        maxFunderDegree: 2
      }).verdict
    ).toBe('independent');
  });
});

describe('purity', () => {
  it('is deterministic and does not mutate its input', () => {
    const arg: FunderIndependenceInput = {
      funder: FUNDER,
      observedFundedWalletCount: 4,
      label: null
    };
    const frozen = Object.freeze({ ...arg });
    const a = assessFunderIndependence(frozen);
    const b = assessFunderIndependence(frozen);
    expect(a).toEqual(b);
    expect(frozen).toEqual(arg);
  });
});

describe('partitionFundersByIndependence', () => {
  const funders: readonly FunderIndependenceInput[] = [
    { funder: 'solana:small', observedFundedWalletCount: 3, label: null },
    { funder: 'solana:cex', observedFundedWalletCount: 900_000, label: null },
    { funder: 'solana:quietCex', observedFundedWalletCount: 2, label: 'exchange' },
    { funder: 'solana:lonely', observedFundedWalletCount: 1, label: null },
    { funder: 'solana:uncounted', observedFundedWalletCount: null, label: null },
    { funder: 'solana:unlabelled', observedFundedWalletCount: 4 }
  ];

  it('sorts every funder into exactly one bucket', () => {
    const p = partitionFundersByIndependence(funders);
    expect(p.independent.map((a) => a.funder)).toEqual(['solana:small']);
    expect(p.hubs.map((a) => a.funder)).toEqual(['solana:cex', 'solana:quietCex']);
    expect(p.belowMinimum.map((a) => a.funder)).toEqual(['solana:lonely']);
    expect(p.unassessed.map((a) => a.funder)).toEqual([
      'solana:uncounted',
      'solana:unlabelled'
    ]);
    const total =
      p.independent.length + p.hubs.length + p.belowMinimum.length + p.unassessed.length;
    expect(total).toBe(funders.length);
  });

  it('keeps the reason for each unassessed funder rather than one flag', () => {
    const p = partitionFundersByIndependence(funders);
    expect(p.unassessed.map((a) => a.code)).toEqual([
      'degree-unknown',
      'hub-label-unchecked'
    ]);
  });

  it('never puts an unassessed funder in independent', () => {
    const p = partitionFundersByIndependence(funders);
    expect(p.independent.every((a) => a.verdict === 'independent')).toBe(true);
    expect(p.independent.every(admitsFundingCluster)).toBe(true);
  });

  it('returns empty buckets for an empty input rather than throwing', () => {
    const p = partitionFundersByIndependence([]);
    expect(p).toEqual({ independent: [], hubs: [], belowMinimum: [], unassessed: [] });
  });

  it('applies one policy across the batch', () => {
    const p = partitionFundersByIndependence(funders, { maxFunderDegree: 3 });
    expect(p.hubs.map((a) => a.funder)).toEqual([
      'solana:cex',
      'solana:quietCex',
      'solana:unlabelled'
    ]);
  });
});

describe('the constants themselves', () => {
  it('leaves orders of magnitude between a person and an exchange', () => {
    // The claim being defended is the band, not the number: any ceiling from ~10
    // to ~1000 classifies both populations identically.
    expect(MAX_FUNDER_DEGREE).toBeGreaterThanOrEqual(10);
    expect(MAX_FUNDER_DEGREE).toBeLessThanOrEqual(1_000);
    expect(MIN_FUNDED_WALLETS).toBeLessThan(MAX_FUNDER_DEGREE);
  });

  it('sits above where the cluster confidence formula stops discriminating', () => {
    // generateFundingClusters scores a cluster as
    // LEAST(0.95, AVG(confidence) + 0.05 * (count - 1)). At the weakest edge
    // confidence the formula saturates at count = 10; past that an extra funded
    // wallet changes nothing the model can express.
    const saturationCount = (0.95 - 0.5) / 0.05 + 1;
    expect(MAX_FUNDER_DEGREE).toBeGreaterThan(saturationCount);
  });

  it('does not list individual as a hub label', () => {
    const hubs: readonly FunderLabel[] = HUB_FUNDER_LABELS;
    expect(hubs).not.toContain('individual');
  });
});
