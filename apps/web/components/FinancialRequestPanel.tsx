'use client';
import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import { createRequestMachine, emptyRequestState, requestEditable, type RequestMachine, type RequestState } from '../lib/financial-request-state.js';
import { admissionAllowed, domainTransport, financialNotice, type DomainCapability, type WithdrawalRequest, type ReductionRequest, type FinancialResponse } from '../lib/domain-transport.js';
import { describeApiError } from '../lib/api-error-message.js';
import { lpDomainTransport, lpExactAdmissionAllowed, lpExactAmount, lpMicroUsd, type LpExactAcquisitionRequest, type LpExactCapabilities, type LpExactPosition, type LpAcquisitionResponse, type LpOperationResponse } from '../lib/domain-transport.js';
import { createLpRequestMachine, emptyLpRequest, validateLpPosition, type LpCommand, type LpRequestMachine, type LpRequestState } from '../lib/lp-request-state.js';

/** Exact intent entry only. Values remain strings; the server checks authoritative scope and exposure. */
export function FinancialRequestPanel({ capability, kind, positionId, venue = 'spot', lpRequest }: {
  capability?: DomainCapability; kind: 'withdrawal' | 'reducing' | 'lp-acquire' | 'lp-operation' | 'lp-copy-mint'; positionId?: string; venue?: 'spot' | 'polymarket-perps';
  lpRequest?: Omit<LpExactAcquisitionRequest, 'operationKey'>;
}) {
  if (kind === 'lp-acquire' || kind === 'lp-operation' || kind === 'lp-copy-mint') return <ExactLpRequestPanel kind={kind} positionId={positionId} acquisition={lpRequest} />;
  return <ExactFinancialRequestPanel capability={capability} kind={kind} positionId={positionId} venue={venue} />;
}
function ExactFinancialRequestPanel({ capability, kind, positionId, venue }: {
  capability?: DomainCapability; kind: 'withdrawal' | 'reducing'; positionId?: string; venue: 'spot' | 'polymarket-perps';
}) {
  const [fields, setFields] = useState<Record<string, string>>({ chain: venue === 'polymarket-perps' ? 'polygon' : 'solana',
    network: '', assetId: '', assetScale: '9', mode: 'paper', maxFeeRaw: '0', feeAssetId: '', feeAssetScale: '9', feeFundingAccountId: '', amountRaw: '', sourceWalletId: '', destination: '',
    accountId: '', positionSide: 'LONG', quantityRaw: '', limitPriceExact: '', expectedRevision: '' });
  const [otp, setOtp] = useState('');
  const [requestState, setRequestState] = useState<RequestState>(emptyRequestState);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const machine = useRef<RequestMachine | null>(null);
  const financialLock = useRef(false);
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
    if (busy || financialLock.current || !machine.current) return; financialLock.current = true; setBusy(true);
    try { const result = await action(); machine.current.observe(result); setNotice(financialNotice(result)); }
    catch (error) {
      if (admission) machine.current.admissionError(error); else machine.current.unknown();
      setNotice(describeApiError(error, 'Outcome unknown; the immutable request is fenced. Retry or reconcile this request only.'));
    } finally { sync(); financialLock.current = false; setBusy(false); }
  };
  const reconcile = () => {
    const state = machine.current?.state(); if (!state?.recordId) return;
    return dispatch(() => kind === 'withdrawal' ? domainTransport.withdrawalStatus(state.recordId!) : domainTransport.reductionStatus(state.recordId!));
  };
  const submit = async () => {
    const controller = machine.current;
    if (!controller || busy || financialLock.current || (requestEditable(controller.state()) && !admissionAllowed(capability))) return;
    if (controller.state().recordId) return reconcile();
    try {
      let operation = controller.state().operation;
      if (requestEditable(controller.state())) {
        const key = crypto.randomUUID();
        const base = { requestKey: key, chain: fields.chain, network: fields.network, assetId: fields.assetId,
          assetScale: Number(fields.assetScale), mode: fields.mode, maxFeeRaw: fields.maxFeeRaw,
          feeAssetId: fields.feeAssetId, feeAssetScale: Number(fields.feeAssetScale), feeFundingAccountId: fields.feeFundingAccountId };
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
    const controller = machine.current; if (!controller || busy || financialLock.current) return;
    try { controller.beginConfirmation(); const auth = controller.state().authorization!; sync();
      return dispatch(() => domainTransport.confirmWithdrawal({ ...auth, otp }));
    } catch (error) { setNotice(describeApiError(error, 'Confirmation unavailable')); }
  };
  const names = ['chain', 'network', 'assetId', 'assetScale', 'mode', 'maxFeeRaw', 'feeAssetId', 'feeAssetScale', 'feeFundingAccountId', ...(kind === 'withdrawal'
    ? ['sourceWalletId', 'destination', 'amountRaw'] : ['accountId', 'positionSide', 'quantityRaw', 'limitPriceExact', 'expectedRevision'])];
  return <details className="border rounded p-3 text-xs">
    <summary>{kind === 'withdrawal' ? 'Exact withdrawal request' : 'Exact reducing request'} — {admissionAllowed(capability) ? 'admission only' : 'unavailable'}</summary>
    <p role="status" className="my-2">Source implemented; configured ports: {capability?.injectedPortsConfigured ? 'yes' : 'no'}. Injected verification, runtime and live acceptance are not established. Queue admission never closes exposure.</p>
    <p className="my-2">Fee raw units use feeAssetScale, not assetScale. The independent domain validates fee funding and collateral; these labels grant no authority.</p>
    {requestState.outcome && <p role="status">Recorded fee ceiling: {requestState.outcome.record.intent.maxFeeRaw} raw · {requestState.outcome.record.intent.feeAssetId} · scale {requestState.outcome.record.intent.feeAssetScale} · funding {requestState.outcome.record.intent.feeFundingAccountId}. {requestState.outcome.record.cancellationReason && `Cancellation: ${requestState.outcome.record.cancellationReason}`}</p>}
    <div className="grid sm:grid-cols-2 gap-2">{names.map(name => <label key={name} className="flex flex-col gap-1">{name}
      <input aria-label={name} value={fields[name]} disabled={busy || !machine.current || !requestEditable(requestState) || !admissionAllowed(capability)}
        onChange={event => setFields({ ...fields, [name]: event.target.value })}
        className="border rounded p-2 bg-surface-container font-mono" /></label>)}</div>
    <button disabled={busy || !machine.current || requestState.phase === 'terminal' || (requestEditable(requestState) && !admissionAllowed(capability))} onClick={() => void submit()} className="border rounded p-2 mt-2 disabled:opacity-40">{requestEditable(requestState) ? 'Record exact intent (not completion)' : 'Retry/reconcile immutable request only'}</button>
    {requestState.authorization && requestState.phase === 'awaiting-authorization' && <div className="mt-2"><label>One-use code<input value={otp} onChange={e => setOtp(e.target.value)} className="border p-2" /></label>
      <button disabled={busy} onClick={() => void confirm()}>Confirm recorded intent only</button></div>}
    {requestState.recordId && <button disabled={busy} className="p-2 underline" onClick={() => void reconcile()}>Refresh durable status</button>}
    {requestState.phase === 'terminal' && <button disabled={busy} onClick={() => { machine.current?.startFresh(); setOtp(''); sync(); }} className="p-2 underline">Start a new freshly authorized request</button>}
    {requestState.phase === 'unknown' && <p role="status">Outcome unknown. Editing and replacement requests are fenced until verified terminal/no-effect resolution. Original key: {requestState.operation?.key}</p>}
    {notice && <p role="status" className="mt-2">{notice}</p>}
  </details>;
}

/** Exact LP admission/observations. No signer, receipt submission or economic input exists here. */
function ExactLpRequestPanel({ kind, positionId, acquisition }: {
  kind: 'lp-acquire' | 'lp-operation' | 'lp-copy-mint'; positionId?: string; acquisition?: Omit<LpExactAcquisitionRequest, 'operationKey'>;
}) {
  const machine = useRef<LpRequestMachine | null>(null), user = useRef<string | null>(null), lock = useRef(false);
  const [state, setState] = useState<LpRequestState>(emptyLpRequest), [capability, setCapability] = useState<LpExactCapabilities | null>(null);
  const [current, setCurrent] = useState<LpExactPosition | null>(null), [busy, setBusy] = useState(false), [notice, setNotice] = useState<string | null>(null);
  const [lookupId, setLookupId] = useState(positionId ?? ''), [copyFields, setCopyFields] = useState({ subscriptionId: '', eventId: '', assetScale: '9' });
  const sync = () => { if (machine.current) setState(machine.current.state()); };
  useEffect(() => {
    let active = true;
    void api.get<{ user: { id: string } }>('/v1/me/account').then(account => {
      if (!active) return;
      const key = `swat-lp-request-v1:${account.user.id}:${kind}:${positionId ?? 'entry'}`;
      const stored = window.localStorage.getItem(key);
      const controller = createLpRequestMachine(account.user.id, next => window.localStorage.setItem(key, JSON.stringify(next)), stored ? JSON.parse(stored) : emptyLpRequest());
      machine.current = controller; user.current = account.user.id; setState(controller.state());
    }).catch(error => { if (active) setNotice(describeApiError(error, 'Persisted LP fence unavailable; submission disabled')); });
    void lpDomainTransport.capabilities().then(value => { if (active) setCapability(value); }).catch(error => { if (active) setNotice(describeApiError(error, 'Exact LP capability unavailable')); });
    return () => { active = false; machine.current = null; user.current = null; };
  }, [kind, positionId]);
  async function readCurrent(id = state.positionId ?? positionId ?? lookupId) {
    if (!id || !user.current) return;
    setCurrent(null); setBusy(true);
    try { const result = await lpDomainTransport.position(id); validateLpPosition(result.position, user.current, id); setCurrent(result.position); setLookupId(id); }
    catch (error) { setNotice(describeApiError(error, 'Current exact position unavailable; acquisition retry is not a current observation')); }
    finally { setBusy(false); }
  }
  async function send(action: 'rebalance' | 'close' = 'rebalance') {
    const controller = machine.current;
    if (!controller || lock.current || (controller.state().phase === 'editable' && !lpExactAdmissionAllowed(capability))) return;
    lock.current = true; setBusy(true);
    try {
      let command: LpCommand;
      if (controller.state().phase === 'editable') {
        command = kind === 'lp-acquire' ? { kind: 'acquire', request: { ...acquisition!, operationKey: crypto.randomUUID() } }
          : kind === 'lp-copy-mint' ? { kind: 'copy-mint', request: { subscriptionId: copyFields.subscriptionId, eventId: copyFields.eventId, assetScale: Number(copyFields.assetScale) } }
          : { kind: 'operation', positionId: current!.id, action, request: { operationKey: crypto.randomUUID() } };
        if (kind === 'lp-acquire' && !acquisition) throw new Error('Exact acquisition parameters unavailable');
        if (kind === 'lp-operation' && (!current || current.state === 'closed')) throw new Error('Read an open current exact position first');
        controller.begin(command);
      } else command = controller.retry();
      sync();
      const result: LpAcquisitionResponse | LpOperationResponse = command.kind === 'acquire' ? await lpDomainTransport.acquire(command.request)
        : command.kind === 'copy-mint' ? await lpDomainTransport.copyMint(command.request)
        : await lpDomainTransport.requestOperation(command.positionId, command.action, command.request);
      controller.observe(result);
      setNotice(command.kind === 'operation'
        ? controller.state().phase === 'resolved' ? 'Bound paper receipt recorded. Refresh current exact inventory; no live closure is inferred.' : 'Operation pending. Queue admission does not close inventory or establish realized economics.'
        : 'Immutable initial paper acquisition recorded. It may since have changed; refresh current exact position separately. No live provider acceptance is established.');
      await readCurrent(controller.state().positionId!);
    } catch (error) {
      if (controller.state().command) controller.unknown();
      setNotice(describeApiError(error, controller.state().command
        ? 'Outcome unknown. Retry the same immutable payload/key only; no replacement is permitted.'
        : 'Draft refused before persistence or dispatch; no request was sent.'));
    } finally { sync(); lock.current = false; setBusy(false); }
  }
  async function reconcile() {
    if (busy || lock.current || !machine.current?.state().operationId) return;
    lock.current = true; setBusy(true);
    try { machine.current.observe(await lpDomainTransport.operation(machine.current.state().operationId!)); setNotice('Durable paper operation observed; refresh current inventory separately.'); await readCurrent(); }
    catch (error) { machine.current?.unknown(); setNotice(describeApiError(error, 'Operation outcome unverified; original key retained')); }
    finally { sync(); lock.current = false; setBusy(false); }
  }
  const editable = state.phase === 'editable';
  return <details className="border rounded p-3 text-xs" open={kind === 'lp-operation'}><summary>Exact LP {kind.replace('lp-', '')} — {lpExactAdmissionAllowed(capability) ? 'paper admission only' : 'unavailable'}</summary>
    <p role="status">Raw/scale DTO implemented. Protocol ports configured: {capability?.injectedPortsConfigured ? 'yes' : 'no'}. This does not establish master/risk availability, runtime acceptance or live capability. {capability?.reason}</p>
    {kind === 'lp-copy-mint' && <div>{Object.keys(copyFields).map(key => <label className="block my-2" key={key}>{key}<input className="border p-2" disabled={busy || !editable} value={copyFields[key as keyof typeof copyFields]} onChange={event => setCopyFields({ ...copyFields, [key]: event.target.value })} /></label>)}<p>Existing tenant subscription and finalized mint event identifiers only. No public budget, quote, provider, risk, receipt or economic authority.</p></div>}
    {kind === 'lp-operation' && <label className="block my-2">Exact position ID<input className="border p-2" value={lookupId} disabled={busy || !editable || !!positionId} onChange={event => { setLookupId(event.target.value); setCurrent(null); }} /></label>}
    {(kind === 'lp-operation' || state.positionId) && <button disabled={busy || !machine.current} className="underline p-2" onClick={() => void readCurrent()}>Read current exact position</button>}
    {current && <p role="status">Current {current.id} · {current.state} · revision {current.revision} · {lpExactAmount(current.currentAmount)} {current.depositAsset} · initial value {lpMicroUsd(current.depositMicroUsd)} · fees {lpMicroUsd(current.cumulativeFeesMicroUsd)} · costs {lpMicroUsd(current.cumulativeCostsMicroUsd)} · realized {lpMicroUsd(current.realizedMicroUsd)}. Auto-rebalance consent: {current.autoRebalance ? 'recorded' : 'off'}; changing consent here is unavailable.</p>}
    {state.phase !== 'resolved' && <button className="border p-2" disabled={busy || !machine.current || (editable && (!lpExactAdmissionAllowed(capability) || (kind === 'lp-operation' && (!current || current.state === 'closed'))))} onClick={() => void send()}>{editable ? kind === 'lp-operation' ? 'Admit exact paper rebalance' : 'Record exact paper acquisition' : 'Retry same immutable payload/key'}</button>}
    {editable && kind === 'lp-operation' && <button className="border p-2" disabled={busy || !machine.current || !lpExactAdmissionAllowed(capability) || !current || current.state === 'closed'} onClick={() => void send('close')}>Admit close (not closed inventory)</button>}
    {state.operationId && <button className="underline p-2" disabled={busy} onClick={() => void reconcile()}>Observe durable operation</button>}
    {state.phase === 'resolved' && <button className="underline p-2" disabled={busy} onClick={() => { machine.current?.fresh(); setCurrent(null); sync(); }}>Start a new explicit request</button>}
    {state.command && <p role="status">Persisted immutable request: <code className="break-all">{JSON.stringify(state.command)}</code></p>}
    {notice && <p role="status">{notice}</p>}
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
