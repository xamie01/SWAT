import { lstat, mkdir, open, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { isAbsolute, join, resolve } from 'node:path';
import { hash, requireCheck } from './core.js';

const secret = /^(?:password|password_hash|token|token_hash|secret|private_key|privateKey|ciphertext|envelope|otp|otp_code|authorization|cookie|credentials)$/i;
function publicValue(value: unknown, depth = 0): unknown {
  requireCheck(depth <= 32, 'Evidence nesting exceeds limit');
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') { requireCheck(Number.isFinite(value), 'Finite evidence number required'); return value; }
  if (typeof value === 'string') {
    requireCheck(value.length <= 1_000_000 && !/[\u0000]/.test(value), 'Evidence string exceeds limit');
    requireCheck(!/(?:postgres(?:ql)?|rediss?|https?):\/\/[^\s/]+@/i.test(value), 'Credential URL refused in public evidence');
    requireCheck(!/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(value), 'Private key refused in public evidence');
    return value;
  }
  if (Array.isArray(value)) { requireCheck(value.length <= 100_000, 'Evidence array exceeds limit'); return value.map(v => publicValue(v, depth + 1)); }
  requireCheck(value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype, 'Plain evidence JSON required');
  const entries = Object.entries(value as Record<string, unknown>);
  requireCheck(entries.length <= 10_000 && entries.every(([key]) => !secret.test(key)), 'Secret-bearing evidence field refused');
  return Object.fromEntries(entries.map(([key, v]) => [key, publicValue(v, depth + 1)]));
}
export function nonsecretEvidence(value: unknown): unknown { return publicValue(value); }

export interface EvidenceRecord { readonly file: string; readonly digest: string; readonly fileSha256: string; readonly bytes: number }
export async function createEvidenceWriter(directory: string) {
  requireCheck(isAbsolute(directory) && directory === resolve(directory), 'Canonical absolute output directory required');
  const parent = await realpath(resolve(directory, '..'));
  requireCheck(join(parent, directory.split('/').at(-1)!) === directory, 'Output parent must not contain symlinks');
  await mkdir(directory, { mode: 0o700 });
  const identity = await lstat(directory);
  requireCheck(identity.isDirectory() && !identity.isSymbolicLink() && identity.uid === process.getuid?.()
    && (identity.mode & 0o077) === 0, 'Private owned output directory required');
  const records: EvidenceRecord[] = [];
  const names = new Set<string>();
  let pending = Promise.resolve();
  const failures: Error[] = [];
  return {
    write(file: string, value: unknown): Promise<EvidenceRecord> {
      requireCheck(/^[a-z][a-z0-9-]{0,100}\.json$/.test(file) && !names.has(file), 'Unique bounded evidence filename required');
      const safe = nonsecretEvidence(value);
      const bytes = Buffer.from(JSON.stringify(safe, null, 2) + '\n');
      requireCheck(bytes.length <= 16 * 1024 * 1024, 'Evidence document exceeds limit');
      names.add(file);
      const action = pending.then(async () => {
        const current = await lstat(directory);
        requireCheck(current.dev === identity.dev && current.ino === identity.ino && current.isDirectory()
          && !current.isSymbolicLink() && current.uid === identity.uid && (current.mode & 0o077) === 0, 'Evidence directory identity changed');
        const handle = await open(join(directory, file), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
        const record = { file, digest: hash(safe), fileSha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
        records.push(record);
        return record;
      });
      pending = action.then(() => {}, () => { failures.push(new Error('Evidence write failed')); });
      return action;
    },
    async settle() {
      await pending;
      requireCheck(failures.length === 0, 'Evidence writes did not all settle successfully');
      return structuredClone(records);
    }
  };
}
