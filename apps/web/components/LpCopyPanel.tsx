'use client';
import { useEffect, useState } from 'react';
import { lpApi } from '../lib/api.js';
import { describeApiError } from '../lib/api-error-message.js';
import { FinancialRequestPanel } from './FinancialRequestPanel.js';
import { observe, loadingObservation, usd, legacyPaperAmount, type Observation } from '../lib/portfolio-model.js';

import { lpMasterCount, lpWinRate, type LpMasterObservation as Master } from '../lib/lp-observation.js';
interface Subscription { id: string; masterWalletAddress: string; chain: string; venue: string; status: 'active' | 'paused' | 'closed'; allocatedBudgetUsd: number; maxCapitalPerPositionUsd: number }
interface Execution { id: string; positionId?: string; status: string; allocatedUsd: number | null; createdAt: string }
export default function LpCopyPanel({ title = 'LP copy records' }: { title?: string }) {
  const [masters, setMasters] = useState<Observation<Master[]>>(loadingObservation);
  const [subscriptions, setSubscriptions] = useState<Observation<Subscription[]>>(loadingObservation);
  const [executions, setExecutions] = useState<Observation<Execution[]>>(loadingObservation);
  const [fields, setFields] = useState({ masterWalletAddress: '', chain: 'solana', venue: 'meteora-dlmm', budget: '1000', capital: '500' });
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState<string | null>(null);
  async function refresh() {
    setMasters(loadingObservation()); setSubscriptions(loadingObservation()); setExecutions(loadingObservation());
    const list = <T,>(value: T[] | undefined): T[] => {
      if (!Array.isArray(value)) throw new Error('Malformed list observation'); return value;
    };
    const [m, s, e] = await Promise.all([
      observe(async () => list((await lpApi.get<{ entries: Master[] }>('/v1/lp/wallets/leaderboard')).entries), 'Leaderboard unavailable'),
      observe(async () => list((await lpApi.get<{ subscriptions: Subscription[] }>('/v1/lp/copy/subscriptions')).subscriptions), 'Subscriptions unavailable'),
      observe(async () => list((await lpApi.get<{ executions: Execution[] }>('/v1/lp/copy/executions')).executions), 'Executions unavailable')
    ]);
    setMasters(m); setSubscriptions(s); setExecutions(e);
  }
  useEffect(() => { void refresh(); }, []);
  async function action(work: () => Promise<unknown>, message: string) {
    if (busy) return; setBusy(true); setNotice(null);
    try { await work(); setNotice(message); await refresh(); }
    catch (error) { setNotice(describeApiError(error, 'Local record request failed; no execution is confirmed')); }
    finally { setBusy(false); }
  }
  return <section className="space-y-5">
    <h1 className="text-xl font-bold">{title}</h1>
    <p role="status" className="text-xs">Recorded observations only. Subscription status is not acquisition or execution authority. Provider/runtime/live qualification is unavailable; no yield or fresh-range guarantee is established.</p>
    <button className="border rounded p-2" disabled={busy} onClick={() => void refresh()}>Refresh records</button>
    {notice && <p role="status">{notice}</p>}
    <FinancialRequestPanel kind="lp-copy-mint" />
    <p className="text-xs">Exact copy mint uses raw/scale server evidence. Legacy subscription budgets and allocation history below remain numeric observations; fractional exact subscription-budget creation and exact aggregate lists are unavailable.</p>
    <section className="border rounded p-4"><h2>Recorded LP masters</h2>
      {masters.state === 'loading' ? <p>Loading…</p> : masters.state === 'unavailable' ? <p role="alert">{masters.error} — not an empty leaderboard.</p>
        : !Array.isArray(masters.data) ? <p role="alert">Malformed observation; unavailable.</p> : masters.data.length === 0 ? <p>No recorded masters.</p>
        : <table className="w-full text-xs"><thead><tr><th>Wallet</th><th>Recorded closed positions</th><th>Recorded PnL</th><th>Win rate</th><th>Use address</th></tr></thead><tbody>
          {masters.data.map(master => <tr key={`${master.chain}:${master.walletAddress}`}><td>{master.walletAddress}</td><td>{lpMasterCount(master.closedPositionCount)}</td><td>{usd(master.realizedPnlUsd)}</td>
            <td>{lpWinRate(master.winRate)}</td><td><button onClick={() => setFields({ ...fields, masterWalletAddress: master.walletAddress, chain: master.chain })}>Select</button></td></tr>)}
        </tbody></table>}
    </section>
    <form className="border rounded p-4 space-y-2" onSubmit={event => { event.preventDefault(); void action(() => {
      if (!fields.masterWalletAddress.startsWith(`${fields.chain}:`)) throw new Error('Master must retain its exact matching chain prefix');
      return lpApi.post('/v1/lp/copy/subscribe', { masterWalletAddress: fields.masterWalletAddress, chain: fields.chain, venue: fields.venue,
        allocatedBudgetUsd: legacyPaperAmount(fields.budget), maxCapitalPerPositionUsd: legacyPaperAmount(fields.capital) });
    }, 'Subscription recorded only. No copied acquisition or live execution is confirmed.'); }}>
      <h2>Record subscription</h2><p className="text-xs">Legacy paper subscription contract: safe whole USD budgets only. This does not create an exact fractional budget or prove copy risk approval.</p>
      {Object.keys(fields).map(key => <label key={key} className="flex gap-2">{key}<input value={fields[key as keyof typeof fields]} disabled={busy}
        className="border rounded p-2 bg-surface-container" onChange={event => setFields({ ...fields, [key]: event.target.value })} /></label>)}
      <button disabled={busy} className="border rounded p-2">Record subscription (not execution)</button>
    </form>
    <section className="border rounded p-4"><h2>Subscription records</h2>
      {subscriptions.state === 'loading' ? <p>Loading…</p> : subscriptions.state === 'unavailable' ? <p role="alert">{subscriptions.error}</p>
        : !Array.isArray(subscriptions.data) ? <p>Malformed observation; unavailable.</p> : subscriptions.data.length === 0 ? <p>No recorded subscriptions.</p>
        : subscriptions.data.map(sub => <div key={sub.id} className="border-b py-2 text-xs">{sub.masterWalletAddress} · {sub.status} · {usd(sub.allocatedBudgetUsd)} recorded budget
          <button disabled={busy || sub.status === 'closed'} className="p-2 underline" onClick={() => void action(() => lpApi.patch(`/v1/lp/copy/subscriptions/${encodeURIComponent(sub.id)}`,
            { status: sub.status === 'active' ? 'paused' : 'active' }), 'Local subscription state updated only. Execution is not confirmed.')}>Toggle active/paused</button>
          <button disabled={busy || sub.status === 'closed'} className="p-2 underline" onClick={() => void action(() => lpApi.delete(`/v1/lp/copy/subscriptions/${encodeURIComponent(sub.id)}`),
            'Subscription closed locally only. Acquired positions were not financially closed.')}>Close subscription record</button></div>)}
    </section>
    <section className="border rounded p-4"><h2>Copy operation observations</h2>
      {executions.state === 'loading' ? <p>Loading…</p> : executions.state === 'unavailable' ? <p role="alert">{executions.error}</p>
        : !Array.isArray(executions.data) ? <p>Malformed observation; unavailable.</p> : executions.data.length === 0 ? <p>No recorded copy operations.</p>
        : executions.data.map(ex => <p key={ex.id}>{ex.id} · {ex.status} · recorded allocation {usd(ex.allocatedUsd)} — submission labels do not establish live completion.</p>)}
    </section>
  </section>;
}
