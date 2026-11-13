import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PublicKey } from '@solana/web3.js';

const __filename = fileURLToPath(import.meta.url);
const PUBLIC_DIR = path.join(path.dirname(__filename), 'public');
const CERTS_DIR = path.join(path.dirname(__filename), 'certs');
const BPF_PROGRAM_ID = '6t6dRetG3Hns4vCfZaj392e9bZ6uTEEmvL37KnDWErfS';

// Preview only: the actual PDA is keyless (ADR-0004). A server HMAC account is
// not a PDA. Do not expose a funding address or enable signing with ephemeral
// state, even when TESTBED_VAULT_SECRET / a devnet opt-in is configured.
// Any future actions require persistent custody recovery, verified devnet,
// explicit opt-in and a durable, atomically consumed server-random intent.
export function previewVault(owner) {
  const ownerKey = new PublicKey(owner);
  const [pda, bump] = PublicKey.findProgramAddressSync(
    [Buffer.from('vault'), ownerKey.toBuffer()], new PublicKey(BPF_PROGRAM_ID),
  );
  return {
    owner: ownerKey.toBase58(), mode: 'preview-only', actionsEnabled: false,
    interactiveVault: null,
    pda: { address: pda.toBase58(), bump, balanceLamports: null },
    notice: 'Address derivation only. Deployment and ownership are not verified. Do not fund this address.',
  };
}

export function requestHandler(req, res) {
  for (const [name, value] of Object.entries({
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer', 'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  })) res.setHeader(name, value);
  const json = (status, body) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.writeHead(status); res.end(JSON.stringify(body));
  };
  let url;
  try { url = new URL(req.url, 'http://localhost'); }
  catch { json(400, { error: 'Invalid request' }); return; }
  if (url.pathname.startsWith('/api/action/')) {
    json(501, { success: false, actionsEnabled: false, error: 'Testbed actions are disabled; read-only PDA preview only' });
    return;
  }
  if (req.method !== 'GET') { json(405, { error: 'Method not allowed' }); return; }
  if (['/api/status', '/health', '/ping'].includes(url.pathname)) {
    let rpcHostname = null;
    try { rpcHostname = new URL(process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com').hostname; } catch { /* unknown, not an invented provider */ }
    json(200, { status: 'ok', mode: 'preview-only', network: 'none', actionsEnabled: false, rpcHostname, bpfProgramId: BPF_PROGRAM_ID });
    return;
  }
  if (url.pathname === '/api/vault-info') {
    try {
      const owner = url.searchParams.get('owner');
      if (!owner) throw new Error('missing owner');
      json(200, previewVault(owner));
    } catch { json(400, { error: 'Invalid owner public key' }); }
    return;
  }
  const files = { '/': ['index.html', 'text/html'], '/index.html': ['index.html', 'text/html'], '/preview.js': ['preview.js', 'text/javascript'] };
  const file = files[url.pathname];
  if (!file) { json(404, { error: 'Not found' }); return; }
  fs.readFile(path.join(PUBLIC_DIR, file[0]), (error, data) => {
    if (error) { json(500, { error: 'Preview unavailable' }); return; }
    res.setHeader('Content-Type', `${file[1]}; charset=utf-8`);
    res.writeHead(200); res.end(data);
  });
}

// Importing the public handler for offline fixtures never reads certificates or
// creates a listener. Only direct execution starts the standalone preview.
if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  const host = process.env.BIND_HOST || '127.0.0.1';
  http.createServer(requestHandler).listen(Number(process.env.PORT || 3333), host);
  const keyPath = path.join(CERTS_DIR, 'key.pem');
  const certPath = path.join(CERTS_DIR, 'cert.pem');
  if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
    https.createServer({ key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) }, requestHandler)
      .listen(Number(process.env.HTTPS_PORT || 3334), host);
  }
}
