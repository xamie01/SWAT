import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createEvidenceWriter, nonsecretEvidence } from './evidence-writer.js';

describe('private nonsecret evidence writer; local files only', () => {
  it.each(['password', 'token', 'privateKey', 'ciphertext', 'otp_code', 'credentials'])('refuses %s fields before output', key => {
    expect(() => nonsecretEvidence({ nested: { [key]: 'synthetic' } })).toThrow('Secret-bearing');
  });
  it.each(['postgresql://user:synthetic@127.0.0.1/db', 'redis://:synthetic@127.0.0.1', '-----BEGIN PRIVATE KEY-----'])('refuses credential-bearing text (%s)', text => {
    expect(() => nonsecretEvidence({ text })).toThrow(/Credential|Private key/);
  });
  it('retains economic raw strings and secret-free identity records', () => {
    const input = { runId: 'synthetic', amount: { raw: '900719925474099312345', scale: 18 }, runtimeAccepted: false };
    expect(nonsecretEvidence(input)).toEqual(input);
  });
  it('writes exclusively with private modes and joins admitted writes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swat-evidence-'));
    try {
      const directory = join(root, 'run'), writer = await createEvidenceWriter(directory);
      const first = writer.write('partial.json', { gate: 'I1', passed: false });
      const second = writer.write('cleanup.json', { ownedWorkJoined: true });
      const results = await Promise.all([first, second]);
      expect(await writer.settle()).toEqual(results);
      expect(JSON.parse(await readFile(join(directory, 'partial.json'), 'utf8'))).toEqual({ gate: 'I1', passed: false });
      expect(results[0].fileSha256).toBe(createHash('sha256').update(await readFile(join(directory, 'partial.json'))).digest('hex'));
      expect(results[0].bytes).toBe((await stat(join(directory, 'partial.json'))).size);
      expect((await stat(directory)).mode & 0o077).toBe(0);
      expect((await stat(join(directory, 'partial.json'))).mode & 0o077).toBe(0);
      expect(() => writer.write('partial.json', {})).toThrow('Unique');
      expect(() => writer.write('../escape.json', {})).toThrow('Unique');
      await expect(createEvidenceWriter(directory)).rejects.toThrow();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('seals new captures while joining writes already admitted', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swat-evidence-sealed-'));
    try {
      const writer = await createEvidenceWriter(join(root, 'run'));
      const admitted = writer.write('partial.json', { pending: true });
      writer.seal();
      expect(() => writer.write('late.json', {})).toThrow('sealed');
      expect(await writer.settle()).toEqual([await admitted]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('retains failed write evidence and still permits a later cleanup write to settle', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swat-evidence-failure-'));
    try {
      const directory = join(root, 'run'), writer = await createEvidenceWriter(directory);
      const { writeFile } = await import('node:fs/promises');
      await writeFile(join(directory, 'partial.json'), 'preexisting', { flag: 'wx', mode: 0o600 });
      await expect(writer.write('partial.json', { passed: true })).rejects.toThrow();
      await writer.write('cleanup.json', { closed: true });
      await expect(writer.settle()).rejects.toThrow('did not all settle');
      expect(await readFile(join(directory, 'partial.json'), 'utf8')).toBe('preexisting');
      expect(JSON.parse(await readFile(join(directory, 'cleanup.json'), 'utf8'))).toEqual({ closed: true });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
