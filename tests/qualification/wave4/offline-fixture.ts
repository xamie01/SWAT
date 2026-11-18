import type { QualificationConfig } from './core.js';

export function config(): QualificationConfig {
  const environment = (runId: string, pgPort: number, redisPort: number, a: string, b: string) => ({ runId,
    postgres: { url: `postgresql://swat_migrator@127.0.0.1:${pgPort}/swat_integration_${runId.replaceAll('-', '')}`,
      containerId: a.repeat(64), imageId: 'e'.repeat(64), memoryBytes: 512 * 1024 ** 2, nanoCpus: 1e9 },
    redis: { url: `redis://127.0.0.1:${redisPort}/0`, containerId: b.repeat(64), imageId: 'f'.repeat(64), memoryBytes: 128 * 1024 ** 2, nanoCpus: 1e9 } });
  const candidate = environment('12345678-1234-4234-8234-123456789abc', 55432, 56379, 'a', 'b');
  return { reference: environment('12345678-1234-4234-8234-123456789abd', 55433, 56380, 'c', 'd'), candidate,
    runtimeUrl: candidate.postgres.url.replace('swat_migrator', 'swat_app'),
    pooledRuntimeUrl: candidate.postgres.url.replace('swat_migrator', 'swat_app').replace(':55432', ':56432'),
    authorization: 'SEPARATELY_AUTHORIZED_DISPOSABLE_WAVE4', maxDurationMs: 60_000 };
}
