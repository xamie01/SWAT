import http from 'k6/http';
import { SharedArray } from 'k6/data';
import { sleep, fail } from 'k6';
import exec from 'k6/execution';
import { Counter, Rate, Trend } from 'k6/metrics';

const config = JSON.parse(open(__ENV.WAVE4_WORKLOAD));
const identities = new SharedArray('wave4 sampled session identities', () => JSON.parse(open(__ENV.WAVE4_IDENTITIES)));
const attempts = new Counter('application_attempts');
const accepted = new Counter('application_accepted');
const refused = new Rate('application_refused');
const throttled = new Rate('application_throttled');
const unavailable = new Rate('application_unavailable');
const latency = new Trend('application_latency', true);
const queueAttempt = new Counter('queue_attempts');
const queueAdmitted = new Counter('queue_admitted');
const fixtureNonempty = new Rate('fixture_nonempty');
const phaseVus = new Trend('phase_vus');
const phaseElapsed = new Trend('phase_elapsed');
const phaseGap = new Trend('phase_gap');
let lastPhaseElapsed = null;
let lastPhase = null;
let walletAttempted = false;
let tokenAttempted = false;

export const options = {
  scenarios: { users: { executor: 'ramping-vus', startVUs: 0, stages: config.stages, gracefulRampDown: '15s', gracefulStop: '15s' } },
  discardResponseBodies: false,
  maxRedirects: 0,
  systemTags: ['status', 'method', 'name', 'scenario', 'expected_response'],
  thresholds: {
    'application_latency{kind:read}': [`p(95)<${config.readP95Ms}`],
    'application_latency{kind:write}': [`p(95)<${config.writeP95Ms}`],
    application_refused: ['rate<0.01'],
    application_throttled: ['rate<0.001'],
    application_unavailable: ['rate<0.01'],
    fixture_nonempty: ['rate>0.99'],
    'queue_admitted{lane:wallet}': [`count>=${config.minQueueAdmissions}`],
    'queue_admitted{lane:token}': [`count>=${config.minQueueAdmissions}`],
    http_req_failed: ['rate<0.01'],
    'phase_vus{phase:hold2000}': ['min>=1990','max<=2000'],
    'phase_vus{phase:hold9000}': ['min>=8990','max<=9000'],
    'phase_gap{phase:hold2000}': ['max<15'], 'phase_gap{phase:hold9000}': ['max<15'],
    'phase_elapsed{phase:hold2000}': ['min<190','max>470'],
    'phase_elapsed{phase:hold9000}': [`min<${490 + Number.parseInt(config.secondRamp)*60}`,`max>${1370 + Number.parseInt(config.secondRamp)*60}`]
  },
  summaryTrendStats: ['avg','min','med','p(90)','p(95)','p(99)','max']
};

export default function () {
  const index = exec.vu.idInTest - 1;
  if (index < 0 || index >= identities.length) fail('Unique VU identity pool exhausted');
  const identity = identities[index];
  if (index === 0) {
    const elapsed = exec.instance.currentTestRunDuration / 1000;
    const peakStart = 480 + Number.parseInt(config.secondRamp)*60;
    const phase = elapsed >= 180 && elapsed < 480 ? 'hold2000' : elapsed >= peakStart && elapsed < peakStart+900 ? 'hold9000' : null;
    if (phase) {
      phaseVus.add(exec.instance.vusActive, { phase }); phaseElapsed.add(elapsed, { phase });
      phaseGap.add(lastPhase === phase ? elapsed-lastPhaseElapsed : 0, { phase });
    }
    lastPhase = phase; lastPhaseElapsed = elapsed;
  }
  const pick = Math.random() * 100;
  const readPick = pick * 80 / config.readPercent;
  const writePick = (pick - config.readPercent) * 20 / (100 - config.readPercent) + 80;
  let name, path, method = 'GET', body = null, kind = 'read', lane, field;
  if (pick < config.readPercent && readPick < 20) { name = 'wallets'; path = '/v1/me/wallets'; field = 'wallets'; }
  else if (pick < config.readPercent && readPick < 40) { name = 'feed'; path = '/v1/me/feed'; field = 'events'; }
  else if (pick < config.readPercent && readPick < 55) { name = 'signals'; path = '/v1/me/signals'; field = 'signals'; }
  else if (pick < config.readPercent && readPick < 65) { name = 'history'; path = `/v1/me/wallets/${encodeURIComponent(identity.historyWallet)}/history`; field = 'transactions'; }
  else if (pick < config.readPercent && readPick < 75) { name = 'settings_read'; path = '/v1/me/execution-settings'; }
  else if (pick < config.readPercent) { name = 'masters'; path = '/v1/me/masters'; }
  else if (writePick < 98) { name = 'settings_write'; path = '/v1/me/execution-settings'; method = 'PATCH'; body = { autoExecute: false }; kind = 'write'; }
  else if (writePick < 99 && !walletAttempted) {
    walletAttempted = true; name = 'wallet_subscribe'; path = '/v1/me/wallets'; method = 'POST'; kind = 'write'; lane = 'wallet';
    body = { address: identity.queueWallet, chain: 'solana', label: 'wave4 finite fixture' };
  } else if (writePick >= 99 && !tokenAttempted) {
    tokenAttempted = true; name = 'token_backfill'; path = '/v1/me/tokens/backfill'; method = 'POST'; kind = 'write'; lane = 'token';
    body = { tokenMint: identity.queueToken, chain: 'solana' };
  } else { name = 'settings_write'; path = '/v1/me/execution-settings'; method = 'PATCH'; kind = 'write'; body = { autoExecute: false }; }
  const tags = { name, kind };
  attempts.add(1, tags);
  if (lane) queueAttempt.add(1, { lane });
  const response = http.request(method, config.baseUrl + path, body ? JSON.stringify(body) : null, {
    headers: { Cookie: `swat_session=${identity.token}; swat_csrf=${identity.csrf}`, 'x-csrf-token': identity.csrf, 'Content-Type': 'application/json' },
    tags, redirects: 0, timeout: '10s', responseType: 'text'
  });
  const ok = response.status === 200 || (lane && response.status === 201);
  accepted.add(ok ? 1 : 0, tags);
  refused.add(!ok, tags);
  throttled.add(response.status === 429, tags);
  unavailable.add(response.status >= 500 || response.status === 0, tags);
  latency.add(response.timings.duration, tags);
  let result;
  try { result = response.json(); } catch { result = null; }
  if (field) fixtureNonempty.add(ok && Array.isArray(result?.[field]) && result[field].length > 0, { name });
  if (lane) {
    // HTTP admission is not worker completion; token job counts are reconciled separately.
    const admitted = lane === 'wallet' ? ok && result?.backfillQueued === true : response.status === 201 && Boolean(result?.watch?.id);
    queueAdmitted.add(admitted ? 1 : 0, { lane });
  }
  sleep(1 + Math.random() * 2);
}

export function handleSummary(data) {
  return { [__ENV.WAVE4_SUMMARY]: JSON.stringify(data, null, 2) };
}
