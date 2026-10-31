import { api } from './api.js';
import { PublicKey } from '@solana/web3.js';

export const WAKE_SOLANA_MAINNET_PROGRAM_ID = '6t6dRetG3Hns4vCfZaj392e9bZ6uTEEmvL37KnDWErfS';
export const WAKE_SOLANA_DEVNET_PROGRAM_ID = 'WakeDev11111111111111111111111111111111111';

/**
 * Derives a real Anchor Program Derived Address (PDA) on Solana:
 * seeds = [b"vault", user_public_key]
 * program_id = WAKE_SOLANA_MAINNET_PROGRAM_ID (or devnet)
 */
export function deriveSolanaAnchorPda(
  userAddress: string,
  cluster: 'mainnet-beta' | 'devnet' = 'mainnet-beta'
): { pdaAddress: string; bump: number } {
  try {
    const userPubkey = new PublicKey(userAddress.trim());
    const progId = new PublicKey(
      cluster === 'devnet' ? WAKE_SOLANA_DEVNET_PROGRAM_ID : WAKE_SOLANA_MAINNET_PROGRAM_ID
    );
    const [pda, bump] = PublicKey.findProgramAddressSync(
      [new TextEncoder().encode('vault'), userPubkey.toBytes()],
      progId
    );
    return { pdaAddress: pda.toBase58(), bump };
  } catch (err) {
    console.warn('Could not derive Anchor PDA with @solana/web3.js:', err);
    return { pdaAddress: WAKE_SOLANA_MAINNET_PROGRAM_ID, bump: 255 };
  }
}

/**
 * Detects whether the active Solana wallet or RPC is targeting devnet or mainnet
 */
export function detectSolanaCluster(provider?: any): 'mainnet-beta' | 'devnet' {
  if (provider) {
    if (provider.isDevnet || provider.cluster === 'devnet' || provider.network === 'devnet') {
      return 'devnet';
    }
    const rpc = provider.connection?._rpcEndpoint || '';
    if (typeof rpc === 'string' && rpc.includes('devnet')) return 'devnet';
  }
  return 'mainnet-beta';
}

/**
 * Robust copy helper that succeeds even on non-HTTPS origins (e.g. raw IP)
 */
export function copyToClipboard(text: string): boolean {
  if (!text) return false;
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      navigator.clipboard.writeText(text).catch(() => {});
      return true;
    }
  } catch {
    // Fall back to execCommand
  }
  if (typeof document !== 'undefined') {
    const el = document.createElement('textarea');
    el.value = text;
    el.setAttribute('readonly', '');
    el.style.position = 'fixed';
    el.style.top = '-9999px';
    el.style.left = '-9999px';
    document.body.appendChild(el);
    el.select();
    try {
      const ok = document.execCommand('copy');
      document.body.removeChild(el);
      return ok;
    } catch {
      document.body.removeChild(el);
      return false;
    }
  }
  return false;
}

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** Encodes raw bytes to Base58 for Solana signatures and public keys */
export function toBase58(bytes: Uint8Array): string {
  const digits = [0];
  for (let i = 0; i < bytes.length; i++) {
    for (let j = 0; j < digits.length; j++) digits[j] <<= 8;
    digits[0] += bytes[i];
    let carry = 0;
    for (let j = 0; j < digits.length; j++) {
      digits[j] += carry;
      carry = (digits[j] / 58) | 0;
      digits[j] %= 58;
    }
    while (carry) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let str = '';
  for (let i = 0; i < bytes.length && bytes[i] === 0; i++) str += ALPHABET[0];
  for (let i = digits.length - 1; i >= 0; i--) str += ALPHABET[digits[i]];
  return str;
}

export interface SolanaWalletConnection {
  address: string;
  provider: any;
  walletName: string;
}

export interface EvmWalletConnection {
  address: string;
  provider: any;
  chainId: string;
  walletName: string;
}

/** Detects injected Solana provider (Phantom, Solflare, Backpack) */
export function getSolanaProvider(): { provider: any; name: string } | null {
  if (typeof window === 'undefined') return null;
  const anyWin = window as any;
  if (anyWin.phantom?.solana?.isPhantom) {
    return { provider: anyWin.phantom.solana, name: 'Phantom' };
  }
  if (anyWin.solflare?.isSolflare) {
    return { provider: anyWin.solflare, name: 'Solflare' };
  }
  if (anyWin.backpack?.isBackpack) {
    return { provider: anyWin.backpack, name: 'Backpack' };
  }
  if (anyWin.solana) {
    return { provider: anyWin.solana, name: anyWin.solana.isPhantom ? 'Phantom' : 'Solana Wallet' };
  }
  return null;
}

/** Detects injected EVM provider (MetaMask, Rabby, Coinbase Wallet, etc.) */
export function getEvmProvider(): { provider: any; name: string } | null {
  if (typeof window === 'undefined') return null;
  const anyWin = window as any;
  if (anyWin.ethereum) {
    let name = 'MetaMask';
    if (anyWin.ethereum.isRabby) name = 'Rabby';
    else if (anyWin.ethereum.isCoinbaseWallet) name = 'Coinbase Wallet';
    else if (anyWin.ethereum.isBraveWallet) name = 'Brave Wallet';
    else if (anyWin.ethereum.isMetaMask) name = 'MetaMask';
    return { provider: anyWin.ethereum, name };
  }
  return null;
}

/** Connects to Solana wallet and retrieves public address */
export async function connectSolanaWallet(): Promise<SolanaWalletConnection> {
  const detected = getSolanaProvider();
  if (!detected) {
    throw new Error('No Solana wallet extension detected. Please install Phantom from https://phantom.app to connect.');
  }

  const { provider, name } = detected;
  const res = await provider.connect({ onlyIfTrusted: false });
  const pubkey = res?.publicKey || provider.publicKey;
  if (!pubkey) {
    throw new Error('Could not read public key from Solana wallet.');
  }
  return {
    address: pubkey.toString(),
    provider,
    walletName: name,
  };
}

/** Signs a SIWS (Sign-In with Solana) challenge message */
export async function signSolanaChallenge(provider: any, message: string): Promise<string> {
  const encoded = new TextEncoder().encode(message);
  const signed = await provider.signMessage(encoded, 'utf8');
  const signatureBytes = signed.signature || signed;
  if (signatureBytes instanceof Uint8Array) {
    return toBase58(signatureBytes);
  }
  if (typeof signatureBytes === 'string') {
    return signatureBytes;
  }
  return toBase58(new Uint8Array(signatureBytes));
}

/** Connects to EVM wallet (MetaMask / Rabby) and retrieves public address */
export async function connectEvmWallet(targetChainId?: '0x89'): Promise<EvmWalletConnection> {
  const detected = getEvmProvider();
  if (!detected) {
    throw new Error('No EVM wallet extension detected. Please install MetaMask from https://metamask.io or Rabby to connect.');
  }

  const { provider, name } = detected;
  const accounts: string[] = await provider.request({ method: 'eth_requestAccounts' });
  if (!accounts || accounts.length === 0) {
    throw new Error('No accounts selected in EVM wallet.');
  }

  const currentChainId: string = await provider.request({ method: 'eth_chainId' }).catch(() => '0x1');

  // If Polygon is targeted (e.g. Polymarket), prompt user to switch
  if (targetChainId && currentChainId.toLowerCase() !== targetChainId.toLowerCase()) {
    try {
      await provider.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: targetChainId }],
      });
    } catch (switchError: any) {
      if (switchError.code === 4902 && targetChainId === '0x89') {
        await provider.request({
          method: 'wallet_addEthereumChain',
          params: [
            {
              chainId: '0x89',
              chainName: 'Polygon Mainnet',
              nativeCurrency: { name: 'POL', symbol: 'POL', decimals: 18 },
              rpcUrls: ['https://polygon-rpc.com'],
              blockExplorerUrls: ['https://polygonscan.com'],
            },
          ],
        });
      }
    }
  }

  return {
    address: accounts[0].toLowerCase(),
    provider,
    chainId: currentChainId,
    walletName: name,
  };
}

/** Signs an EIP-4361 SIWE challenge message */
export async function signEvmChallenge(provider: any, message: string, address: string): Promise<string> {
  return await provider.request({
    method: 'personal_sign',
    params: [message, address],
  });
}

/**
 * End-to-end authenticating and linking a self-custody wallet:
 * 1. Requests single-use challenge nonce from API
 * 2. Prompts the wallet popup to sign the challenge
 * 3. Verifies and registers cryptographic proof with the backend
 */
export async function linkWalletWithSignature(params: {
  chainKind: 'solana' | 'evm';
  address: string;
  provider: any;
}): Promise<{ chainKind: string; address: string; verifiedAt: string }> {
  // 1. Get nonce & challenge message from server
  const nonceRes = await api.post<{ nonce: string; message: string; expiresAt: string }>('/v1/auth/wallet/nonce', {
    chainKind: params.chainKind,
    address: params.address,
  });

  if (!nonceRes?.message) {
    throw new Error('Failed to obtain challenge message from authentication server.');
  }

  // 2. Prompt wallet extension signature
  let signature: string;
  if (params.chainKind === 'solana') {
    signature = await signSolanaChallenge(params.provider, nonceRes.message);
  } else {
    signature = await signEvmChallenge(params.provider, nonceRes.message, params.address);
  }

  // 3. Post proof to verification endpoint
  const verifyRes = await api.post<{ wallet: { chainKind: string; address: string; verifiedAt: string } }>('/v1/auth/wallet/verify', {
    chainKind: params.chainKind,
    address: params.address,
    message: nonceRes.message,
    signature,
  });

  return verifyRes.wallet;
}

/**
 * Prompts the connected EVM wallet (MetaMask / Rabby) to sign the Polymarket
 * ClobAuth EIP-712 typed data via eth_signTypedData_v4.
 */
export async function signPolymarketClobAuth(
  provider: any,
  address: string,
  typedData: any
): Promise<string> {
  try {
    return await provider.request({
      method: 'eth_signTypedData_v4',
      params: [address, JSON.stringify(typedData)],
    });
  } catch (err: any) {
    if (err?.code === 4001) {
      throw new Error('Polymarket authentication signature rejected by user.');
    }
    throw err;
  }
}
