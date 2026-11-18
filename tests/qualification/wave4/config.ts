import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { requireCheck, validateConfig, type QualificationConfig } from './core.js';

export async function privateConfig(path: string): Promise<QualificationConfig> {
  requireCheck(isAbsolute(path), 'Absolute private configuration path required');
  const stat = await lstat(path);
  requireCheck(stat.isFile() && !stat.isSymbolicLink() && stat.uid === process.getuid?.() && (stat.mode & 0o077) === 0,
    'Caller-owned regular configuration with no group/other permissions required');
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = await handle.stat();
    requireCheck(opened.isFile() && opened.uid === process.getuid?.() && (opened.mode & 0o077) === 0
      && opened.dev === stat.dev && opened.ino === stat.ino && opened.size === stat.size && opened.size <= 64 * 1024,
      'Configuration identity, permissions or size changed');
    const bytes = Buffer.alloc(64 * 1024 + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    const after = await handle.stat();
    requireCheck(bytesRead === opened.size && after.size === opened.size && after.mtimeMs === opened.mtimeMs
      && after.ctimeMs === opened.ctimeMs, 'Configuration changed while reading');
    return validateConfig(JSON.parse(bytes.subarray(0, bytesRead).toString('utf8')));
  } finally { await handle.close(); }
}
