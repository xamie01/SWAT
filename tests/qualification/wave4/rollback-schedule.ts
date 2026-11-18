import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { Deadline } from './containment.js';
import { assertion, requireCheck, type SqlClient } from './core.js';
import { runtimeTransaction } from './domains.js';

export async function exerciseRollbackSchedule(first: SqlClient, second: SqlClient, observer: SqlClient, userId: string, deadline: Deadline) {
  deadline.check();
  const baseline = await runtimeTransaction(first, userId, async c => {
    const rows = (await c.query('SELECT auto_execute FROM user_execution_settings WHERE user_id=$1', [userId])).rows;
    requireCheck(rows.length === 1 && typeof rows[0].auto_execute === 'boolean', 'One owned rollback baseline required');
    return rows[0].auto_execute as boolean;
  });
  const competitorPid = await runtimeTransaction(second, userId, async c => (await c.query('SELECT pg_backend_pid() AS pid')).rows[0]?.pid);
  requireCheck(Number.isSafeInteger(competitorPid), 'Owned competitor backend required');
  let holderPid: number | undefined, holderFailure: unknown;
  let release!: () => void, ready!: () => void;
  const released = new Promise<void>(resolve => { release = resolve; });
  const holding = new Promise<void>(resolve => { ready = resolve; });
  const rollback = new Error('Intentional owned rollback');
  const cancel = deadline.enroll(release);
  const holder = runtimeTransaction(first, userId, async c => {
    holderPid = (await c.query('SELECT pg_backend_pid() AS pid')).rows[0]?.pid;
    await c.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [userId]);
    requireCheck((await c.query('UPDATE user_execution_settings SET auto_execute=$2 WHERE user_id=$1', [userId,!baseline])).rowCount === 1,
      'Owned rollback writer did not update exactly one row');
    ready();
    await released;
    throw rollback;
  });
  // The holder may fail before readiness; every path must still release and settle both transactions.
  void holder.catch(error => { holderFailure = error; ready(); });
  let competitor: Promise<boolean> | undefined, observed = false;
  let failure: unknown;
  try {
    await holding;
    deadline.check();
    if (holderFailure) throw holderFailure;
    requireCheck(Number.isSafeInteger(holderPid) && holderPid !== competitorPid, 'Independent owned SQL backends required');
    competitor = runtimeTransaction(second, userId, async c => {
      const pid = (await c.query('SELECT pg_backend_pid() AS pid')).rows[0]?.pid;
      requireCheck(pid === competitorPid, 'Competitor backend changed; direct connection required');
      await c.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [userId]);
      const rows = (await c.query('SELECT auto_execute FROM user_execution_settings WHERE user_id=$1', [userId])).rows;
      requireCheck(rows.length === 1, 'Rollback competitor lost owned row');
      return rows[0].auto_execute === baseline;
    });
    void competitor.catch(() => {});
    const until = performance.now() + Math.min(1000, deadline.remaining());
    do {
      const blockers = await runtimeTransaction(observer, userId, async c => (await c.query(
        'SELECT $1::integer=ANY(pg_blocking_pids($2::integer)) AS blocked', [holderPid,competitorPid])).rows[0]?.blocked);
      observed = blockers === true;
      if (!observed) await delay(10, undefined, { signal: deadline.signal });
      deadline.check();
    } while (!observed && performance.now() < until);
  } catch (error) { failure = error; }
  finally { release(); cancel(); }
  const settled = await Promise.allSettled([holder, ...(competitor ? [competitor] : [])]);
  deadline.check();
  if (failure) throw failure;
  const holderResult = settled[0], competitorResult = settled[1];
  requireCheck(holderResult?.status === 'rejected' && holderResult.reason === rollback, 'Holder did not intentionally rollback');
  requireCheck(competitorResult?.status === 'fulfilled', 'Competitor did not commit after owned rollback');
  return [assertion('actual lock observer identifies owned holder blocking competitor', observed),
    assertion('competing transaction sees baseline only after rollback', competitorResult.value === true)];
}
