import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(fileURLToPath(new URL('../sql/080_immutable_valuation_corrections.sql', import.meta.url)), 'utf8');
const proposal = readFileSync(fileURLToPath(new URL('../../../threats/project-completion-20261117/wave080-financial-schema.proposal.sql', import.meta.url)), 'utf8');
const trigger = migration.split('CREATE FUNCTION public.guard_worker_correction()')[1]!.split('CREATE TRIGGER worker_correction_guard')[0]!;

// Source regression only; PostgreSQL trigger execution requires isolated qualification.
describe('correction admission statement-time expiry', () => {
  it('keeps the retained proposal identical to the integrated migration', () => {
    expect(proposal).toBe(migration);
  });
  it('assigns acceptance before authority checks and never uses transaction-start time', () => {
    expect(trigger.indexOf('NEW.accepted_at:=statement_timestamp();')).toBeLessThan(trigger.indexOf('SELECT * INTO e'));
    expect(trigger).not.toMatch(/\bnow\s*\(|\bCURRENT_TIMESTAMP\b/i);
  });
  it.each([
    'a.valid_until<=NEW.accepted_at',
    'v.valid_until<=NEW.accepted_at',
    'p.valid_until>NEW.accepted_at',
    'proof.provider_valid_until>NEW.accepted_at'
  ])('compares admission expiry with %s', comparison => {
    expect(trigger).toContain(comparison);
  });
});
