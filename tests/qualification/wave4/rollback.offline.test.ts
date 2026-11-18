import { describe, expect, it, vi } from 'vitest';
import { Deadline } from './containment.js';
import { exerciseRollbackSchedule } from './rollback-schedule.js';

const transaction = vi.hoisted(() => ({ rollback: () => {} }));
vi.mock('./domains.js', () => ({ runtimeTransaction: async (c: unknown, _user: string, action: (c: unknown) => unknown) => {
  try { return await action(c); } catch (error) { transaction.rollback(); throw error; }
} }));

describe('rollback schedule injected control contracts, not PostgreSQL evidence', () => {
  it.each(['blocked','unobserved','observer-failure','holder-failure'])('releases and settles controlled schedule on %s', async mode => {
    const deadline = new Deadline(5000), events: string[] = [];
    let rolledBack!: () => void;
    const rollback = new Promise<void>(resolve => { rolledBack = resolve; });
    transaction.rollback = () => { events.push('rollback'); rolledBack(); };
    const first = { query: async (sql: string) => {
      if (sql.includes('pg_backend_pid')) return {rows:[{pid:1}]};
      if (sql.startsWith('UPDATE')) {
        if (mode === 'holder-failure') throw new Error('holder failed');
        return {rows:[],rowCount:1};
      }
      return {rows:[{auto_execute:false}]};
    } };
    const second = { query: async (sql: string) => {
      if (sql.includes('pg_backend_pid')) return {rows:[{pid:2}]};
      if (sql.includes('FOR UPDATE')) { events.push('competing'); await rollback; events.push('unblocked'); return {rows:[]}; }
      return {rows:[{auto_execute:false}]};
    } };
    const observer = { query: async () => {
      events.push('observed');
      if (mode === 'observer-failure') throw new Error('observer failed');
      return {rows:[{blocked:mode === 'blocked'}]};
    } };
    try {
      const work = exerciseRollbackSchedule(first,second,observer,'synthetic',deadline);
      if (mode.endsWith('failure')) await expect(work).rejects.toThrow();
      else { const checks = await work; expect(checks[0]?.passed).toBe(mode === 'blocked'); expect(checks[1]?.passed).toBe(true); }
      expect(events).toContain('rollback');
      if (mode !== 'holder-failure') {
        expect(events).toContain('unblocked');
        expect(events.indexOf('rollback')).toBeLessThan(events.indexOf('unblocked'));
      } else expect(events).not.toContain('competing');
    } finally { deadline.dispose(); }
  });
});
