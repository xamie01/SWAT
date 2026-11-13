#!/usr/bin/env python3
"""Create and update the ordered implementation ledger without altering audit evidence."""
import json
import sys
from pathlib import Path

ROOT = Path('/home/xahmie/Documents/SWAT')
OUT = ROOT/'threats/sequential-fixes'
GROUPS = [
 ('01','Enforce proof before Robinhood enrollment and remove false delegation success',['PF-WEB-01','PF-WEB-04','PF-WEB-05','PF-WEB-06'],['API-07'],'Authenticated enrollment/challenge endpoints; no mutation or authorization success without verified usable authority'),
 ('02','Bind and atomically consume payment credit; strictly decode transfer evidence',['PF-WEB-02','PF-WEB-03','PF-WEB-20','PF-WEB-16'],['API-01','API-02','API-04'],'Billing verification/intent endpoints and transactional payment writer'),
 ('03','Make grant replacement and scoped revocation atomic and truthful',['PF-WEB-07','PF-WEB-08','PF-WEB-09','PF-SEC-02','PF-SEC-03'],['API-03','CHAIN-02','CHAIN-06'],'Grant registration/replacement/revocation and vault rendering'),
 ('04','Bind durable exact withdrawal intents and enforce settings authorization',['PF-WEB-10'],['API-06','API-08'],'Withdrawal intent issue/confirm and user settings API; no unsupported financial side effect'),
 ('05','Centralize secure server targets and browser trust headers',['PF-WEB-15','PF-SEC-15'],['LEAK-02','INF-04','WEB-05','WEB-06'],'SSR/middleware/rewrite URL resolution, cookies, navigation and response headers'),
 ('06','Redact sensitive diagnostics and minimize API/log/browser disclosures',['PF-WEB-18','PF-WEB-19','PF-WEB-21','PF-WEB-22','PF-WEB-23','PF-DATA-20'],['LEAK-01','LEAK-03','LEAK-04','LEAK-05','LEAK-06','LEAK-07'],'RPC/error/log serialization, sensitive response projection, SSE and health'),
 ('07','Repair testbed syntax, persistent signing isolation, replay and DOM sinks',['PF-WEB-11','PF-WEB-12','PF-WEB-13','PF-WEB-14'],['WEB-01','WEB-02','WEB-03','OWA-02','OWA-05','OWA-07'],'Standalone server parser, canonical signed intent and safe text rendering'),
 ('08','Make session revocation authoritative across caches',['PF-DATA-11'],['DB-03'],'Session resolve/revoke/password-change with fake DB/time and isolated concurrency'),
 ('09','Constrain database roles, lock topology and migration replay',['PF-DATA-09','PF-DATA-10','PF-DATA-12','PF-DATA-13'],['DB-01','DB-02','DB-05','DB-06','INF-03','RUN-01','RUN-02'],'Pool policy, transactional scope, direct advisory-lock connection and migration discovery'),
 ('10','Require attributable successful Solana swaps and correct decimal/fee attribution',['PF-DATA-01','PF-DATA-02','PF-DATA-03'],['IDX-01','IDX-02','IDX-03'],'Pure parser and actual ingestion adapters with deterministic fixtures'),
 ('11','Bound market ingestion and preserve net quantities, finality and unknown metadata',['PF-DATA-04','PF-DATA-05','PF-DATA-06','PF-DATA-07','PF-DATA-08'],['IDX-04','IDX-05','IDX-06','IDX-07','IDX-08','RUN-03'],'Source event construction, provider pagination and canonical evidence'),
 ('12','Align scorer evidence and independent-control policy',['PF-DATA-14','PF-DATA-15'],['SIG-06','SIG-07'],'Metric eligibility and cluster/hub admission with explicit unknowns'),
 ('13','Separate shared source state from per-tenant execution',['PF-EXE-07'],['EXE-02'],'Canonical source claim and sequential operator/two-tenant fan-out'),
 ('14','Preserve exit ownership, acquisition mode and lot identity end to end',['PF-EXE-04','PF-EXE-05','PF-EXE-09'],['SIG-03','SIG-04'],'Close-all/stop-loss producer to canonical execution/evidence/trade persistence'),
 ('15','Reserve only the selling masters available lots atomically',['PF-EXE-06'],['SIG-02'],'Source/explicit lot exit reservations and concurrent fill allocation'),
 ('16','Apply reducing-exit policy through enqueue and worker',['PF-EXE-08','PF-EXE-11'],['SIG-05','EXE-03'],'Owned exits bypass entry-only checks but respect explicit stops/current policy'),
 ('17','Make Jito submit and receipt recovery durable with typed identities',['PF-EXE-01','PF-EXE-03'],['EXE-06','EXE-07'],'Runtime pending store, transport and durable canonical settlement'),
 ('18','Authorize exact final signing bytes and bounded economic policy',['PF-EXE-02','PF-SEC-01'],['EXE-05','CHAIN-01'],'Signer intent validation and owner-approved contract policy'),
 ('19','Reserve exposure/capacity and fence emergency state',['PF-EXE-10','PF-EXE-12','PF-EXE-13'],['EXE-04','DB-04','SIG-08'],'Atomic spend/capacity reservation and current stop/policy checks'),
 ('20','Retain durable per-user signal and exit delivery obligations',['PF-EXE-14'],['SIG-09'],'Fan-out outbox/recovery and clean-skip outcomes'),
 ('21','Bind encrypted resources and signature/permission helper semantics',['PF-EXE-15','PF-EXE-16','PF-EXE-17','PF-DATA-19'],['CRY-02','CRY-03','CRY-04','CRY-05'],'Envelope context/version, single-use exact intents and semantic ABI policies'),
 ('22','Protect LP registry, value risk in USD and complete rebalance lifecycle',['PF-SEC-04','PF-SEC-05','PF-SEC-06'],['SEC-03','SEC-04','SEC-05'],'User LP API to registry/build/risk/worker state'),
 ('23','Correct perps close and bound dormant execution inputs',['PF-SEC-07','PF-SEC-11'],['SEC-06','SEC-07'],'Owned financial closure and isolated order helper fail-closed capability'),
 ('24','Make alert/discovery delivery ownership and retries durable',['PF-SEC-08','PF-SEC-09'],['SEC-08','SEC-09'],'Notification lease/outbox and persisted wallet backfill intent'),
 ('25','Constrain ML artifact and path trust boundaries',['PF-SEC-10'],['SEC-10'],'Local artifact loading and storage-root containment'),
 ('26','Harden contract governance/resource checks and add executable invariants',['PF-SEC-16','PF-SEC-17','PF-SEC-18'],['CHAIN-03','CHAIN-04','CHAIN-05','CHAIN-07'],'Owner/config authorization, account/program constraints and local program test fixtures'),
 ('27','Make deployment sources least-privileged and acquisition isolated',['PF-SEC-12','PF-SEC-13','PF-SEC-14'],['INF-01','INF-02','INF-06'],'CI artifact/tool boundaries, systemd working paths and install policy'),
 ('28','Fix limiter configuration and safe integration-test isolation',['PF-WEB-17','PF-DATA-16','PF-DATA-17','PF-DATA-18'],['API-05','TEST-01','TEST-02','TEST-03'],'Bounded early-IP/parsed-account limiter, disposable infrastructure guard and unique fixtures'),
 ('29','Revalidate existing closures and build/dependency/runtime gates',[],['EXE-01','EXE-08','SEC-01','SEC-02','MCP-01','MCP-02','MCP-03','INF-05','OWA-01','OWA-03','OWA-04','OWA-06','OWA-08','RUN-04','RUN-05','RUN-06'],'Final focused/full-safe regressions, source closure and explicit operational blockers')
]

def main():
    path=OUT/'ledger.json'
    if not path.exists():
        data={'baselineHead':'8905505595802c21053118b5fab3fd53a8a1654c','branch':'fix/sequential-threat-remediation','constraints':['sequential CPU0','no production/real credentials/trades','no commit or push','preserve original audit evidence'],'items':[{'sequence':i,'title':t,'currentFindings':f,'priorIds':p,'seams':s,'status':'pending','evidence':[],'notes':[]} for i,t,f,p,s in GROUPS]}
    else:data=json.loads(path.read_text())
    if len(sys.argv)>1:
        item=next(x for x in data['items'] if x['sequence']==sys.argv[1])
        item['status']=sys.argv[2]
        if len(sys.argv)>3:item['notes'].append(sys.argv[3])
    path.write_text(json.dumps(data,indent=2)+'\n')
    lines=['# Sequential threat remediation ledger','', '**Implementation branch:** `fix/sequential-threat-remediation`. Baseline HEAD `8905505`. Original audit reports are retained unchanged.','','## Execution policy','','One numbered package at a time. Every package uses its public seam below, a failing regression or previously established red evidence, a minimal root correction, then focused and neighboring tests. These seams follow the user-authorized audit fixes; no extra confirmation gate is required. All local workloads are sequential on CPU 0. No real credentials, financial transactions, production changes, commits or pushes. Deployment/key/venue properties are never marked fixed by source edits alone.','','Statuses: pending, in-progress, fixed-tested, source-fixed-runtime-blocked, blocked, superseded-by-shared-fix. A safe refusal/containment is identified as such, not passed off as a completed financial feature.','','| Order | Fix package | Current audit findings | Prior IDs | Status | Verification seam |','|---|---|---|---|---|---|']
    for x in data['items']:
        lines.append(f"| {x['sequence']} | {x['title']} | {', '.join(x['currentFindings']) or 'Acceptance and retained closures'} | {', '.join(x['priorIds'])} | {x['status']} | {x['seams']} |")
    lines+=['','## Package notes and evidence','']
    for x in data['items']:
        if x['notes'] or x['evidence']:
            lines.append('### '+x['sequence']+' — '+x['title'])
            lines.extend('- '+n for n in x['notes'])
            lines.extend('- Evidence: '+n for n in x['evidence'])
    (ROOT/'threats/SEQUENTIAL-FIX-LEDGER.md').write_text('\n'.join(lines)+'\n')
    print('Ledger updated:',len(data['items']),'sequential packages')

if __name__=='__main__':main()
