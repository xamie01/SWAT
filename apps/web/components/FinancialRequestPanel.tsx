'use client';
import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import { createRequestMachine, emptyRequestState, requestEditable, type RequestMachine, type RequestState } from '../lib/financial-request-state.js';
import { admissionAllowed, domainTransport, financialNotice, type DomainCapability, type WithdrawalRequest, type ReductionRequest, type FinancialResponse } from '../lib/domain-transport.js';
import { describeApiError } from '../lib/api-error-message.js';

/** Exact intent entry only. Values remain strings; the server checks authoritative scope and exposure. */
export function FinancialRequestPanel({ capability, kind, positionId, venue = 'spot' }: {
  capability?: DomainCapability; kind: 'withdrawal' | 'reducing'; positionId?: string; venue?: 'spot' | 'polymarket-perps';
}) {
  const [fields, setFields] = useState<Record<string, string>>({ chain: venue === 'polymarket-perps' ? 'polygon' : 'solana',
    network: '', assetId: '', assetScale: '9', mode: 'paper', maxFeeRaw: '0', amountRaw: '', sourceWalletId: '', destination: '',
    accountId: '', positionSide: 'LONG', quantityRaw: '', limitPriceExact: '', expectedRevision: '' });
  const [otp, setOtp] = useState('');
  const [requestState, setRequestState] = useState<RequestState>(emptyRequestState);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const machine = useRef<RequestMachine | null>(null);
  useEffect(() => {
    // Partition persisted fences by the authenticated account, not a global shared browser slot.
    let active = true;
    void api.get<{ user: { id: string } }>('/v1/me/account').then(account => {
      const storageKey = `swat-request-v1:${account.user.id}:${kind}:${venue}:${positionId ?? 'withdrawal'}`;
      const saved = window.localStorage.getItem(storageKey);
      const controller = createRequestMachine(state => window.localStorage.setItem(storageKey, JSON.stringify(state)),
        saved ? JSON.parse(saved) as RequestState : emptyRequestState());
      if (active) { machine.current = controller; setRequestState(controller.state()); }
    }).catch(error => { if (active) setNotice(describeApiError(error, 'Durable client fence unavailable; submission disabled')); });
    return () => { active = false; machine.current = null; };
  }, [kind, venue, positionId]);
  const sync = () => { if (machine.current) setRequestState(machine.current.state()); };
  const dispatch = async (action: () => Promise<FinancialResponse>, admission = false) => {
    if (busy || !machine.current) return; setBusy(true);
    try { const result = await action(); machine.current.observe(result); setNotice(financialNotice(result)); }
    catch (error) {
      if (admission) machine.current.admissionError(error); else machine.current.unknown();
      setNotice(describeApiError(error, 'Outcome unknown; the immutable request is fenced. Retry or reconcile this request only.'));
    } finally { sync(); setBusy(false); }
  };
  const reconcile = () => {
    const state = machine.current?.state(); if (!state?.recordId) return;
    return dispatch(() => kind === 'withdrawal' ? domainTransport.withdrawalStatus(state.recordId!) : domainTransport.reductionStatus(state.recordId!));
  };
  const submit = async () => {
    const controller = machine.current;
    if (!controller || busy || !admissionAllowed(capability)) return;
    if (controller.state().recordId) return reconcile();
    try {
      let operation = controller.state().operation;
      if (requestEditable(controller.state())) {
        const key = crypto.randomUUID();
        const base = { requestKey: key, chain: fields.chain, network: fields.network, assetId: fields.assetId,
          assetScale: Number(fields.assetScale), mode: fields.mode, maxFeeRaw: fields.maxFeeRaw };
        const request = kind === 'withdrawal' ? { ...base, sourceWalletId: fields.sourceWalletId, destination: fields.destination, amountRaw: fields.amountRaw }
          : { ...base, accountId: fields.accountId, positionSide: fields.positionSide, quantityRaw: fields.quantityRaw,
            limitPriceExact: fields.limitPriceExact, expectedRevision: fields.expectedRevision };
        controller.beginAdmission({ key, kind, positionId, venue, request }); operation = controller.state().operation;
      } else operation = controller.retryAdmission();
      sync();
      const pinned = operation!;
      return dispatch(() => pinned.kind === 'withdrawal' ? domainTransport.requestWithdrawal(pinned.request as unknown as WithdrawalRequest)
        : domainTransport.reduce(pinned.venue!, pinned.positionId!, pinned.request as unknown as ReductionRequest), true);
    } catch (error) { sync(); setNotice(describeApiError(error, 'Cannot replace an unresolved request')); }
  };
  const confirm = () => {
    const controller = machine.current; if (!controller || busy) return;
    try { controller.beginConfirmation(); const auth = controller.state().authorization!; sync();
      return dispatch(() => domainTransport.confirmWithdrawal({ ...auth, otp }));
    } catch (error) { setNotice(describeApiError(error, 'Confirmation unavailable')); }
  };
  const names = ['chain', 'network', 'assetId', 'assetScale', 'mode', 'maxFeeRaw', ...(kind === 'withdrawal'
    ? ['sourceWalletId', 'destination', 'amountRaw'] : ['accountId', 'positionSide', 'quantityRaw', 'limitPriceExact', 'expectedRevision'])];
  return <details className="border rounded p-3 text-xs">
    <summary>{kind === 'withdrawal' ? 'Exact withdrawal request' : 'Exact reducing request'} — {admissionAllowed(capability) ? 'admission only' : 'unavailable'}</summary>
    <p role="status" className="my-2">Source implemented; configured ports: {capability?.injectedPortsConfigured ? 'yes' : 'no'}. Injected verification, runtime and live acceptance are not established. Queue admission never closes exposure.</p>
    <div className="grid sm:grid-cols-2 gap-2">{names.map(name => <label key={name} className="flex flex-col gap-1">{name}
      <input aria-label={name} value={fields[name]} disabled={busy || !machine.current || !requestEditable(requestState) || !admissionAllowed(capability)}
        onChange={event => setFields({ ...fields, [name]: event.target.value })}
        className="border rounded p-2 bg-surface-container font-mono" /></label>)}</div>
    <button disabled={busy || !machine.current || requestState.phase === 'terminal' || !admissionAllowed(capability)} onClick={() => void submit()} className="border rounded p-2 mt-2 disabled:opacity-40">{requestEditable(requestState) ? 'Record exact intent (not completion)' : 'Retry/reconcile immutable request only'}</button>
    {requestState.authorization && requestState.phase === 'awaiting-authorization' && <div className="mt-2"><label>One-use code<input value={otp} onChange={e => setOtp(e.target.value)} className="border p-2" /></label>
      <button disabled={busy} onClick={() => void confirm()}>Confirm recorded intent only</button></div>}
    {requestState.recordId && <button disabled={busy} className="p-2 underline" onClick={() => void reconcile()}>Refresh durable status</button>}
    {requestState.phase === 'terminal' && <button disabled={busy} onClick={() => { machine.current?.startFresh(); setOtp(''); sync(); }} className="p-2 underline">Start a new freshly authorized request</button>}
    {requestState.phase === 'unknown' && <p role="status">Outcome unknown. Editing and replacement requests are fenced until verified terminal/no-effect resolution. Original key: {requestState.operation?.key}</p>}
    {notice && <p role="status" className="mt-2">{notice}</p>}
  </details>;
}

/** Consent identifiers must already exist at the independent service; this form never connects/signs or sends credentials. */
export function LocalEnrollmentPanel({ capability }: { capability?: DomainCapability }) {
  const [fields, setFields] = useState({ chain: 'polygon', grantKind: 'polymarket_signer', accountAddress: '', consentId: '', expectedRevision: '' });
  const [notice, setNotice] = useState<string | null>(null), [busy, setBusy] = useState(false);
  const allowed = capability?.contractVersion === 1 && capability.localEnrollmentSupported === true && capability.injectedPortsConfigured === true;
  return <details className="border rounded p-3 text-xs"><summary>Local custody enrollment — {allowed ? 'record only' : 'unavailable'}</summary>
    <p>Requires independently verified linked account, exact consent and deployed mechanism. No credential acquisition, wallet signature or execution authority is created here.</p>
    <form onSubmit={event => { event.preventDefault(); if (!allowed || busy) return; setBusy(true); setNotice(null);
      void domainTransport.enrollLocal(fields).then(result => {
        const response = result as { localOnly?: unknown; executionSupported?: unknown; grant?: { id?: unknown } };
        setNotice(response.localOnly === true && response.executionSupported === false && typeof response.grant?.id === 'string'
          ? 'Local record created only. Live execution and funding remain unavailable.' : 'Outcome unverified; no execution is confirmed.');
      }).catch(error => setNotice(describeApiError(error, 'Local enrollment unavailable'))).finally(() => setBusy(false));
    }}>
      {Object.keys(fields).map(key => <label className="flex gap-2 my-2" key={key}>{key}<input className="border p-2 bg-surface-container"
        value={fields[key as keyof typeof fields]} disabled={!allowed || busy} onChange={event => setFields({ ...fields, [key]: event.target.value })} /></label>)}
      <button disabled={!allowed || busy} className="border p-2">Record verified local enrollment</button>
    </form>{notice && <p role="status">{notice}</p>}
  </details>;
}
