#!/usr/bin/env python3
"""Consolidate explicit source-level dispositions without adding overlapping IDs."""
import collections
import json
from pathlib import Path

ROOT = Path('/home/xahmie/Documents/SWAT')
OUT = ROOT/'threats/post-fix-8905505'
old = json.loads((ROOT/'threats/evidence/finding-register.json').read_text())
previous = {item['id']: item for item in old['findings']}
records = {}
for part in ['api-web', 'execution', 'secondary-contract']:
    for item in json.loads((OUT/(part+'-closures.json')).read_text()):
        record = dict(item)
        record['assessmentArtifact'] = part+'-review.md'
        record['confidence'] = record['confidence'].replace('(path read)', '')
        records[record['id']] = record

additions = []
def add(id, status, confidence, evidence, reason, testGap, findings=()):
    entry = {'id':id, 'status':status, 'confidence':confidence, 'currentEvidence':evidence,
             'reason':reason, 'testGap':testGap, 'findingIds':list(findings),
             'assessmentArtifact':'data-indexer-review.md'}
    records[id] = entry
    additions.append(entry)

add('DB-01','open','Likely',['packages/db/src/evm-nonce.ts:87-126','packages/db/src/migrate.ts:18-37','deploy/pgbouncer/pgbouncer.ini:23'],
    'Session-lock SQL still uses the general connection pool; documented transaction pooling does not preserve backend affinity, and false unlock results are ignored.',
    'No real pooler/database tests; require session-pinned/direct connection and isolated multi-backend test.', ['PF-DATA-09'])
add('DB-02','open','Verified',['packages/db/sql/064_row_level_security.sql:29-45,89-114','packages/db/src/tenancy.ts:72-110','packages/db/src/client.ts:10-27,65-68','packages/db/src/users.ts:105-115,242-255'],
    'RLS is still conditional on role and tenant settings; non-swat_app unscoped policies permit rows, while blindly switching unscoped auth calls to strict role breaks access. Actual role unknown.',
    'Isolated actual application-role login/tenant/admin denial matrix required.', ['PF-DATA-10'])
add('DB-03','partial','Verified',['packages/db/src/users.ts:125-138,182-239,242-288','session-invariants.test.ts:15-26'],
    'Post-commit local invalidation improved, but a synthetic pre-revoke resolution repopulated the cache afterward. No distributed invalidation or expiry check on cached identity.',
    'Synthetic race failed; full multi-process real-DB/session expiry tests not run.', ['PF-DATA-11'])
add('DB-05','open','Verified',['packages/db/sql/064_row_level_security.sql:47-64'],
    'Predictable source-default LOGIN credential and broad present/future grants remain; no runtime credentials read.',
    'Fresh and existing-role provisioning with constrained grants/attributes required.', ['PF-DATA-12'])
add('DB-06','open','Likely',['packages/db/src/migrate.ts:21-32','packages/db/sql/066_lp_dashboard.sql:168-193','packages/db/sql/067_lp_auto_rebalance.sql:24-44'],
    'Replaying separately committed files transiently reinstalls the narrower transition function before restoring active-to-rebalancing.',
    'No live migration; isolated replay/concurrent LP fixture needed.', ['PF-DATA-13'])

idx = {
  1:('Verified',['apps/indexer/src/parse.ts:183-209,234-260','apps/indexer/src/index.ts:157-164,251-305'],'Parser still treats opposing balances as supported successful swap evidence. Missing-provenance and failed-status synthetic assertions failed.'),
  2:('Verified',['apps/indexer/src/parse.ts:138-155,179-209','apps/indexer/src/source-trade-lifecycle.ts:81-105'],'Mixed raw-unit maxima still choose target/quote; ambiguous multi-asset fixture was accepted.'),
  3:('Verified',['apps/indexer/src/webhook-helpers.ts:102-133','apps/indexer/src/webhook.ts:64-75','apps/indexer/src/parse.ts:162-176'],'Enhanced adapter makes nonpayer index zero; synthetic fixture received another account fee refund.'),
  4:('Likely',['apps/indexer/src/source-trade-lifecycle.ts:92-105,148-163,188-203','apps/indexer/src/evm.ts:166-195','packages/db/src/copy-trade-lifecycle.ts:719-746'],'Builders still assert confirmed evidence; bounded production search found no confirmation-advance caller. Actual reversal incidence unverified.'),
  5:('Likely',['apps/indexer/src/source-trade-lifecycle.ts:116-163','packages/db/src/transactions.ts:110-132','apps/indexer/src/polymarket.ts:355-399'],'Canonical economic-content fill identity differs from legacy transaction/wallet/token identity; provider split/correction guarantees remain unknown.'),
  6:('Verified',['apps/indexer/src/robinhood-ingestion.ts:190-262','apps/indexer/src/evm.ts:455-488'],'Pool totals and gross received/sent wallet quantity remain inconsistent with net attributable inventory.'),
  7:('Verified',['apps/indexer/src/polymarket.ts:152-157,180-185,199-209,245-272'],'Missing risk/end/tick metadata still becomes false/current-time/default-size context.'),
  8:('Verified',['apps/indexer/src/polymarket.ts:67-128,314-317'],'Only immediate repeated cursor is stopped; production omits total cap and operation deadline.')
}
for number,(confidence,evidence,reason) in idx.items():
    add(f'IDX-{number:02}','open',confidence,evidence,reason,
        'See data-indexer-review.md for bounded source coverage and exact synthetic or proposed contract-specific regression.', [f'PF-DATA-{number:02}'])

add('SIG-06','open','Likely',['packages/db/src/scoring-queries.ts:19-115','packages/shared/src/scoring.ts:44-59','apps/scorer/src/index.ts:96-101'],
    'Score still consumes legacy aggregates without verified independent-counterparty/attributable-quality inputs. Real manipulation economics not tested.',
    'Confirmed attributable round-trip and adversarial historical-data fixtures needed.', ['PF-DATA-14'])
add('SIG-07','open','Verified',['packages/db/src/clustering-queries.ts:34-44','packages/db/src/independence.ts:288-317','packages/db/src/independence-queries.ts:32-98','apps/api/src/routes/me.ts:1114-1125'],
    'SQL admission still differs from positive-label pure policy; no membership and not-blacklisted are not measured independence.',
    'Unassessed hub and multiple-membership fixtures required.', ['PF-DATA-15'])
add('CRY-03','open','Verified',['apps/api/src/routes/me.ts:674-688,876-893','packages/shared/src/authority/key-wrapper.ts:42-107','packages/shared/src/authority/envelope.ts:86-118'],
    'Current API itself instantiates symmetric wrapping/unwrapping authority; exact wrapper-id opening does not implement multi-version rotation.',
    'No actual master key inspected; verify separate wrap-only identity and audited rotation with throwaway keys.', ['PF-DATA-19'])

for number,confidence,evidence,reason in [
 (1,'Verified',['vitest.integration.config.ts:1-17','tests/integration/chaos.integration.test.ts:45-61,343-345,415-418'],'Test-name suffix does not isolate endpoints; chaos still terminates other PostgreSQL and all normal Redis clients.'),
 (2,'Verified',['tests/integration/helpers/lifecycle-fixture.ts:5-7,18-29,97-115,197-224'],'Solana fixtures still share fixed addresses and account-wide cleanup.'),
 (3,'Verified',['tests/integration/helpers/schema-guard.ts:26-70,73-109'],'Selected object-existence checks do not prove current policies/constraints/profile or latest required tables.')]:
    add(f'TEST-{number:02}','open',confidence,evidence,reason,'Integration and chaos intentionally not run; isolated fixture/control tests proposed.',[f'PF-DATA-{15+number:02}'])

for id,alias in [('WEB-01','OWA-02'),('WEB-02','OWA-05'),('WEB-03','OWA-07')]:
    record=dict(records[alias]);record['id']=id;record['aliasEvidenceFrom']=alias;records[id]=record
add('WEB-05','open','Likely',['apps/web/app/login/page.tsx:44-55'],
    'Relative-leading-slash check remains string-only and excludes only literal double slash. Browser/framework normalization edge cases were not tested.',
    'Isolated browser backslash/encoded-separator navigation tests required before exploitation claim.')
add('WEB-06','not-verified','Needs check',['apps/web/next.config.ts:25-63'],
    'Inspected Next config contains no security-header policy despite closure claim; actual edge/browser headers unknown.',
    'No deployed or rendered browser header inspection; cannot certify CSP/HSTS/framing controls.')

add('RUN-01','not-verified','Needs check',['packages/db/src/client.ts:10-27','packages/db/sql/064_row_level_security.sql:29-64'],
    'Prior local superuser observation was not remeasured after fixes. Source does not validate actual pool role flags.',
    'Current isolated and deployment runtime role interrogation not performed.')
add('RUN-02','not-verified','Needs check',['packages/db/src/migrate.ts:10-32','tests/integration/helpers/schema-guard.ts:26-70'],
    'No database schema connected or migrated in this pass; historical completion claim does not establish present schema.',
    'Fresh full-profile migration plus current-schema digest/constraint comparison required.')
add('RUN-03','partial','Verified',['apps/indexer/src/index.ts:442-452,537-548'],
    'Two RPC reads now request SOLANA_MAX_TX_VERSION or default 1 and report failures; value lacks bounded-integer validation and no real version-1 success was replayed here.',
    'Synthetic version/error handling and bounded public/fork replay would be separate checks.')
add('RUN-04','open','Verified',['apps/web/context/appkit.tsx:4-9','apps/web/components/WalletConnectModalButton.tsx:4-5','web-source-typecheck.log'],
    'Current source no-emit typecheck fails with ten unresolved-module diagnostics, including newly added AppKit/Wagmi/query dependencies and existing web3/tailwind. This is installed-checkout evidence, not proof the declared packages are absent from manifest.',
    'No dependency install or full production build; current clean install/build not certified.')
add('RUN-05','partial','Verified',['apps/api/src/index.ts:284-331','packages/shared/src/rpc-failover.ts:267-302','sensitive-flow-invariants.test.ts:33-36'],
    'Public health accurately renamed URL booleans configured, removing the specific false healthy label. It still checks only DB/Redis overall. Dedicated RPC probe accepts null result as healthy in a synthetic test.',
    'No actual endpoint requests or stalled-body test; require strict result validation and full deadline.', ['PF-DATA-20'])
add('RUN-06','not-verified','Needs check',['apps/web/package.json:13-24','pnpm-lock.yaml'],
    'Dependency declarations/lockfile changed and MCP source was removed, but no fresh registry advisory/reachability audit was run. Earlier advisory counts are not current closure evidence.',
    'Fresh pinned inventory and context-specific advisory triage required; no package installation or network audit here.')

expected=set(previous)|{f'OWA-{n:02}' for n in range(1,9)}|{f'LEAK-{n:02}' for n in range(1,8)}|{f'RUN-{n:02}' for n in range(1,7)}
assert set(records)==expected, {'missing':sorted(expected-set(records)),'extra':sorted(set(records)-expected)}
for id,item in records.items():
    if id in previous:
        item['originalSeverity']=previous[id]['severity']
        item['originalConfidence']=previous[id]['confidence']
        item['originalReport']=previous[id]['report']
    item['currentStatusScope']='Source-level unless explicitly accompanied by isolated test evidence; not production closure'

ordered=[records[id] for id in sorted(records)]
counts=collections.Counter(item['status'] for item in ordered)
(OUT/'data-indexer-closures.json').write_text(json.dumps(additions,indent=2)+'\n')
(OUT/'closure-ledger.json').write_text(json.dumps({'head':'8905505595802c21053118b5fab3fd53a8a1654c','counts':dict(counts),'overlapWarning':'97 tracked IDs = 76 retained +15 overlapping focused OWASP +6 runtime; not 97 unique vulnerabilities','items':ordered},indent=2)+'\n')
lines=['# Post-fix closure ledger','', '**97 tracked IDs, not 97 independent vulnerabilities.** The original 76 are retained; the 15 focused OWASP and six runtime rows overlap them. Source closure is not deployed closure.','','| Disposition | Count |','|---|---:|']
for k,v in sorted(counts.items()):lines.append(f'| {k} | {v} |')
lines+=['','| Prior ID | Current disposition | Confidence | Reason and current evidence |','|---|---|---|---|']
for row in ordered:
    def fmt(e):
        if isinstance(e,str):return e
        return e.get('path','')+(':'+str(e['lines']) if e.get('lines') else '')
    evidence='; '.join(fmt(e) for e in row['currentEvidence'])
    reason=row['reason'].replace('|','/')
    lines.append(f"| {row['id']} | {row['status']} | {row['confidence']} | {reason} Evidence: {evidence.replace('|','/')} |")
(OUT/'closure-ledger.md').write_text('\n'.join(lines)+'\n')
print(json.dumps({'trackedIds':len(ordered),'counts':dict(counts),'missing':[]},indent=2))
