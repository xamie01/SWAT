import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { assertion, result, type QualificationPorts } from './core.js';
import { config } from './offline-fixture.js';
import { runEvidenceQualification, type EvidenceQualificationPorts } from './evidence-session.js';

const read = async (directory: string, file: string) => JSON.parse(await readFile(join(directory, file), 'utf8'));
async function withOutput(action: (directory: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'swat-evidence-session-'));
  try { await action(join(root, 'run')); } finally { await rm(root, { recursive: true, force: true }); }
}
const ports = (): QualificationPorts => ({ inspect: vi.fn(async () => {}),
  execute: vi.fn(async gate => result(gate, [assertion('injected-only', true)])), close: vi.fn(async () => {}) });

describe('joined evidence session, injected capabilities only', () => {
  it('persists ordered gates, joined cleanup and a detached index without accepting runtime', async () => withOutput(async directory => {
    const p = ports(), report = await runEvidenceQualification(config(), directory, p);
    expect(report.observedGatesComplete).toBe(true);
    expect(report.runtimeAccepted).toBe(false);
    expect(p.close).toHaveBeenCalledOnce();
    const index = await read(directory, 'evidence-index.json');
    expect(index.records.map((r: { file: string }) => r.file)).toEqual(['run.json', 'inspection.json',
      ...['i1', 'i2', 'i3', 'i4', 'i5', 'i6', 'i7', 'i8'].map(g => `gate-${g}.json`), 'cleanup.json', 'qualification.json']);
    expect(index).toMatchObject({ closeStarted: true, closeComplete: true, runtimeAccepted: false });
    expect((await read(directory, 'qualification.json')).results).toHaveLength(8);
  }));
  it.each(['blocked', 'failed', 'empty', 'duplicate'])('keeps partial %s gate evidence and closes before report', async mode => withOutput(async directory => {
    const p = { ...ports(), execute: vi.fn(async (gate: Parameters<QualificationPorts['execute']>[0]) => result(gate,
      mode === 'empty' ? [] : mode === 'duplicate' ? [assertion('same', true), assertion('same', true)]
        : [assertion('one', mode !== 'failed')], mode === 'blocked' ? ['external capability absent'] : [])) };
    const report = await runEvidenceQualification(config(), directory, p);
    expect(report.observedGatesComplete).toBe(false);
    expect(report.results).toHaveLength(1);
    expect(await read(directory, 'gate-i1.json')).toMatchObject({ gate: 'I1' });
    expect(await read(directory, 'cleanup.json')).toMatchObject({ closeComplete: true });
    expect(await readdir(directory)).not.toContain('gate-i2.json');
  }));
  it.each(['inspect', 'execute', 'close'])('records sanitized %s failure and attempts owned cleanup', async point => withOutput(async directory => {
    const p = ports();
    const fail = async () => { throw new Error('postgresql://user:synthetic@127.0.0.1/private'); };
    const bad = { ...p, [point]: vi.fn(fail) } as QualificationPorts;
    const report = await runEvidenceQualification(config(), directory, bad);
    expect(report.failure).not.toBeNull();
    expect(report.runtimeAccepted).toBe(false);
    expect(bad.close).toHaveBeenCalledOnce();
    expect(JSON.stringify(await read(directory, 'qualification.json'))).not.toContain('synthetic@');
    expect(await read(directory, 'cleanup.json')).toMatchObject({ closeStarted: true, closeComplete: point !== 'close' });
  }));
  it('refuses substituted gate output before persisting it', async () => withOutput(async directory => {
    const p = ports();
    const report = await runEvidenceQualification(config(), directory, { ...p, execute: async () => result('I2', [assertion('false identity', true)]) });
    expect(report.results).toEqual([]);
    expect(report.failure).not.toBeNull();
    expect(await readdir(directory)).not.toContain('gate-i1.json');
    expect(p.close).toHaveBeenCalledOnce();
  }));
  it('refuses secret-bearing gate payloads and still writes cleanup and failure report', async () => withOutput(async directory => {
    const p = ports();
    const report = await runEvidenceQualification(config(), directory, { ...p, execute: async gate => result(gate,
      [assertion('injected', true)], [], { password: 'synthetic-never-publish' }) });
    expect(report.failure).not.toBeNull();
    expect(report.results).toHaveLength(0);
    expect(await read(directory, 'cleanup.json')).toMatchObject({ closeComplete: true });
    expect(JSON.stringify(await read(directory, 'qualification.json'))).not.toContain('synthetic-never-publish');
  }));
  it('does not create output or call capabilities for invalid declarations', async () => withOutput(async directory => {
    const p = ports();
    await expect(runEvidenceQualification({ ...config(), authorization: 'no' } as any, directory, p)).rejects.toThrow();
    expect(p.inspect).not.toHaveBeenCalled(); expect(p.close).not.toHaveBeenCalled();
    await expect(readdir(directory)).rejects.toThrow();
  }));
  it('joins unawaited admitted gate output and closes retained capture capability', async () => withOutput(async directory => {
    let capture: Parameters<EvidenceQualificationPorts['execute']>[3] | undefined;
    const p = { ...ports(), execute: async (...[gate, _config, _deadline, raw]: Parameters<EvidenceQualificationPorts['execute']>) => {
      capture = raw;
      void raw('raw-snapshot.json', { independentlyObserved: false });
      return result(gate, [assertion('injected', true)], ['one gate only']);
    } };
    await runEvidenceQualification(config(), directory, p);
    expect(await read(directory, 'raw-snapshot.json')).toEqual({ independentlyObserved: false });
    expect(() => capture!('late.json', {})).toThrow('closed');
    expect(await readdir(directory)).not.toContain('late.json');
    expect((await read(directory, 'evidence-index.json')).records.some((r: { file: string }) => r.file === 'raw-snapshot.json')).toBe(true);
  }));
  it('seals evidence before an uncooperative inspection resumes after report return', async () => withOutput(async directory => {
    let finish: () => void = () => {};
    const report = await runEvidenceQualification(config(), directory, { ...ports(), inspect: (_c, deadline) => {
      const work = new Promise<void>(resolve => { finish = resolve; });
      deadline.abort();
      return work;
    } });
    const before = (await readdir(directory)).sort();
    expect(report.containmentComplete).toBe(false);
    expect(report.pendingWork).toBe(1);
    finish();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect((await readdir(directory)).sort()).toEqual(before);
    expect(before).not.toContain('inspection.json');
  }));
  it('never overwrites an existing evidence directory', async () => withOutput(async directory => {
    await runEvidenceQualification(config(), directory, ports());
    const p = ports();
    await expect(runEvidenceQualification(config(), directory, p)).rejects.toThrow();
    expect(p.inspect).not.toHaveBeenCalled(); expect(p.close).not.toHaveBeenCalled();
    expect(await read(directory, 'evidence-index.json')).toMatchObject({ runtimeAccepted: false });
  }));
});
