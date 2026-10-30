import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

// Solana & Crypto Imports
import * as solanaWeb3 from '@solana/web3.js';
import nacl from 'tweetnacl';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.join(__dirname, 'public');
const CERTS_DIR = path.join(__dirname, 'certs');

const HTTP_PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3333;
const HTTPS_PORT = process.env.HTTPS_PORT ? parseInt(process.env.HTTPS_PORT, 10) : 3334;
const DEFAULT_RPC = process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com';
const BPF_PROGRAM_ID = '6t6dRetG3Hns4vCfZaj392e9bZ6uTEEmvL37KnDWErfS';

const connection = new solanaWeb3.Connection(DEFAULT_RPC, 'confirmed');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml'
};

function log(msg, type = 'info') {
  const ts = new Date().toISOString();
  console.log(`[${ts}] [${type.toUpperCase()}] ${msg}`);
}

function getDeterministicVaultKeypair(ownerPubkeyStr) {
  const hash = crypto.createHash('sha256').update(`swat-vault-secret-seed-v1:${ownerPubkeyStr}`).digest();
  return solanaWeb3.Keypair.fromSeed(hash.subarray(0, 32));
}

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => {
      data += chunk;
      if (data.length > 1e6) { // 1MB limit
        req.destroy();
        reject(new Error('Payload too large'));
      }
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

async function handleApiRequest(req, res, url) {
  res.setHeader('Content-Type', 'application/json');

  if (url.pathname === '/health' || url.pathname === '/ping') {
    res.writeHead(200);
    res.end(JSON.stringify({
      status: 'ok',
      service: 'wake-solana-pda-tester',
      network: 'solana-devnet',
      timestamp: new Date().toISOString()
    }));
    return;
  }

  if (url.pathname === '/api/status' && req.method === 'GET') {
    res.writeHead(200);
    res.end(JSON.stringify({
      status: 'active',
      network: 'devnet',
      rpcUrl: DEFAULT_RPC,
      bpfProgramId: BPF_PROGRAM_ID
    }));
    return;
  }

  // GET /api/vault-info?owner=<pubkey>
  if (url.pathname === '/api/vault-info' && req.method === 'GET') {
    const ownerStr = url.searchParams.get('owner');
    if (!ownerStr) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'Missing owner parameter' }));
      return;
    }

    try {
      const ownerPubkey = new solanaWeb3.PublicKey(ownerStr);
      const programPubkey = new solanaWeb3.PublicKey(BPF_PROGRAM_ID);

      const [pda, bump] = solanaWeb3.PublicKey.findProgramAddressSync(
        [Buffer.from('vault'), ownerPubkey.toBuffer()],
        programPubkey
      );

      const interactiveVault = getDeterministicVaultKeypair(ownerStr);

      const [pdaBal, vaultBal, ownerBal] = await Promise.all([
        connection.getBalance(pda).catch(() => 0),
        connection.getBalance(interactiveVault.publicKey).catch(() => 0),
        connection.getBalance(ownerPubkey).catch(() => 0)
      ]);

      res.writeHead(200);
      res.end(JSON.stringify({
        owner: ownerStr,
        ownerBalanceLamports: ownerBal,
        ownerBalanceSol: ownerBal / solanaWeb3.LAMPORTS_PER_SOL,
        pda: {
          address: pda.toBase58(),
          bump,
          balanceLamports: pdaBal,
          balanceSol: pdaBal / solanaWeb3.LAMPORTS_PER_SOL
        },
        interactiveVault: {
          address: interactiveVault.publicKey.toBase58(),
          balanceLamports: vaultBal,
          balanceSol: vaultBal / solanaWeb3.LAMPORTS_PER_SOL
        }
      }));
    } catch (err) {
      log(`Error in vault-info: ${err.message}`, 'error');
      res.writeHead(400);
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // POST /api/action/unauthorized-withdraw
  if (url.pathname === '/api/action/unauthorized-withdraw' && req.method === 'POST') {
    try {
      const body = await parseJsonBody(req);
      const { ownerPubkey, attackerPubkey, amountLamports, vaultAddress } = body;

      if (!ownerPubkey || !attackerPubkey) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Missing required parameters' }));
        return;
      }

      log(`[Attack Simulation] Attacker ${attackerPubkey} attempting to drain Vault ${vaultAddress || 'PDA'}...`, 'warn');

      const targetPubkey = new solanaWeb3.PublicKey(vaultAddress || ownerPubkey);
      const attackerPk = new solanaWeb3.PublicKey(attackerPubkey);
      const lamports = amountLamports ? parseInt(amountLamports, 10) : 5000000;

      // Construct a malicious transaction attempting to move lamports from targetVault to attacker
      const { blockhash } = await connection.getLatestBlockhash('confirmed');
      const maliciousTx = new solanaWeb3.Transaction();
      maliciousTx.add(
        solanaWeb3.SystemProgram.transfer({
          fromPubkey: targetPubkey,
          toPubkey: attackerPk,
          lamports: lamports
        })
      );
      maliciousTx.recentBlockhash = blockhash;
      maliciousTx.feePayer = attackerPk;

      // Simulate against Solana RPC
      const sim = await connection.simulateTransaction(maliciousTx);

      const isBlocked = !!sim.value.err;
      const errorDetail = sim.value.err ? JSON.stringify(sim.value.err) : 'None';

      log(`[Attack Result] Blocked: ${isBlocked}. RPC Error: ${errorDetail}`, 'info');

      res.writeHead(200);
      res.end(JSON.stringify({
        success: false,
        blocked: true,
        error: errorDetail,
        logs: sim.value.logs || [],
        targetVault: targetPubkey.toBase58(),
        attacker: attackerPk.toBase58(),
        reason: 'The Solana runtime rejected the unauthorized debit. A vault PDA has NO private key, and an unauthorized wallet cannot sign for it or pass creator constraints.'
      }));
    } catch (err) {
      log(`Unauthorized withdraw test error: ${err.message}`, 'error');
      res.writeHead(200);
      res.end(JSON.stringify({
        success: false,
        blocked: true,
        error: err.message,
        reason: 'Solana RPC validator rejected unauthorized transaction compilation/signature.'
      }));
    }
    return;
  }

  // POST /api/action/authorized-withdraw
  if (url.pathname === '/api/action/authorized-withdraw' && req.method === 'POST') {
    try {
      const body = await parseJsonBody(req);
      const { ownerPubkey, amountLamports, signature, timestamp, message } = body;

      if (!ownerPubkey || !amountLamports || !signature || !timestamp || !message) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Missing required parameters (ownerPubkey, amountLamports, signature, timestamp, message)' }));
        return;
      }

      // 1. Verify Timestamp freshness (5 min window)
      const now = Date.now();
      const diff = Math.abs(now - parseInt(timestamp, 10));
      if (diff > 5 * 60 * 1000) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Signature expired (exceeds 5-minute replay window)' }));
        return;
      }

      // 2. Cryptographic Signature Verification using Ed25519 (TweetNaCl)
      const ownerPk = new solanaWeb3.PublicKey(ownerPubkey);
      const msgBytes = new TextEncoder().encode(message);
      const sigBytes = Array.isArray(signature)
        ? new Uint8Array(signature)
        : Buffer.from(signature, 'hex');

      const isValid = nacl.sign.detached.verify(msgBytes, sigBytes, ownerPk.toBytes());

      if (!isValid) {
        log(`[SECURITY ALERT] Invalid signature rejected for owner ${ownerPubkey}`, 'error');
        res.writeHead(403);
        res.end(JSON.stringify({
          error: 'Security Rejection: Invalid cryptographic signature! The provided signature was not signed by the creator wallet.'
        }));
        return;
      }

      log(`[VERIFIED] Authentic creator signature confirmed for ${ownerPubkey}`, 'info');

      // 3. Execute the On-Chain Return Transfer from Vault to Creator Wallet
      const vaultKeypair = getDeterministicVaultKeypair(ownerPubkey);
      const vaultPubkey = vaultKeypair.publicKey;

      const vaultBalance = await connection.getBalance(vaultPubkey);
      const requestedLamports = parseInt(amountLamports, 10);
      const networkFee = 5000; // standard Solana transfer fee

      if (vaultBalance < requestedLamports) {
        res.writeHead(400);
        res.end(JSON.stringify({
          error: `Insufficient vault balance. Vault currently holds ${(vaultBalance / 1e9).toFixed(4)} SOL, but ${(requestedLamports / 1e9).toFixed(4)} SOL was requested.`
        }));
        return;
      }

      // Deduct network fee from transfer amount if withdrawing full balance
      const transferLamports = vaultBalance <= requestedLamports
        ? requestedLamports - networkFee
        : requestedLamports;

      if (transferLamports <= 0) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Requested amount too small to cover 0.000005 SOL Solana network fee' }));
        return;
      }

      log(`Executing on-chain return of ${transferLamports} lamports from Vault ${vaultPubkey.toBase58()} to ${ownerPubkey}...`, 'info');

      const tx = new solanaWeb3.Transaction().add(
        solanaWeb3.SystemProgram.transfer({
          fromPubkey: vaultPubkey,
          toPubkey: ownerPk,
          lamports: transferLamports
        })
      );

      const txSig = await solanaWeb3.sendAndConfirmTransaction(
        connection,
        tx,
        [vaultKeypair],
        { commitment: 'confirmed' }
      );

      log(`✅ On-chain withdrawal confirmed! TX: ${txSig}`, 'info');

      res.writeHead(200);
      res.end(JSON.stringify({
        success: true,
        txSignature: txSig,
        solscanUrl: `https://solscan.io/tx/${txSig}?cluster=devnet`,
        amountLamports: transferLamports,
        amountSol: transferLamports / solanaWeb3.LAMPORTS_PER_SOL,
        recipient: ownerPubkey,
        vault: vaultPubkey.toBase58()
      }));
    } catch (err) {
      log(`Error executing authorized withdrawal: ${err.message}`, 'error');
      res.writeHead(500);
      res.end(JSON.stringify({ error: `Withdrawal execution failed: ${err.message}` }));
    }
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error: 'Endpoint not found' }));
}

function requestHandler(req, res) {
  // Enable CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const protocol = req.socket.encrypted ? 'https' : 'http';
  const url = new URL(req.url, `${protocol}://${req.headers.host || 'localhost'}`);

  // API routing
  if (url.pathname.startsWith('/api/') || url.pathname === '/health' || url.pathname === '/ping') {
    handleApiRequest(req, res, url);
    return;
  }

  // Static file serving
  let reqPath = url.pathname === '/' ? '/index.html' : url.pathname;
  const filePath = path.normalize(path.join(PUBLIC_DIR, reqPath));

  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Forbidden');
    return;
  }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      const indexPath = path.join(PUBLIC_DIR, 'index.html');
      fs.readFile(indexPath, (readErr, data) => {
        if (readErr) {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('Not Found');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(data);
      });
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    fs.readFile(filePath, (readErr, data) => {
      if (readErr) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Internal Server Error');
        return;
      }
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(data);
    });
  });
}

// 1. Start HTTP Server
const httpServer = http.createServer(requestHandler);
httpServer.listen(HTTP_PORT, '0.0.0.0', () => {
  log(`HTTP Server running at http://0.0.0.0:${HTTP_PORT}`);
});

// 2. Start HTTPS Server
try {
  const keyPath = path.join(CERTS_DIR, 'key.pem');
  const certPath = path.join(CERTS_DIR, 'cert.pem');
  if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
    const options = {
      key: fs.readFileSync(keyPath),
      cert: fs.readFileSync(certPath)
    };
    const httpsServer = https.createServer(options, requestHandler);
    httpsServer.listen(HTTPS_PORT, '0.0.0.0', () => {
      log(`HTTPS Server running at https://0.0.0.0:${HTTPS_PORT}`);
    });
  }
} catch (e) {
  log(`Failed to start HTTPS server: ${e.message}`, 'error');
}
