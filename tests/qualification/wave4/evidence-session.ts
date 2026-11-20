import { validateConfig, qualify, requireCheck, type QualificationConfig, type QualificationPorts } from './core.js';
import { createEvidenceWriter, nonsecretEvidence } from './evidence-writer.js';

type CaptureEvidence = Awaited<ReturnType<typeof createEvidenceWriter>>['write'];
export interface EvidenceQualificationPorts extends Omit<QualificationPorts, 'execute'> {
  readonly execute: (...args: [...Parameters<QualificationPorts['execute']>, CaptureEvidence]) => ReturnType<QualificationPorts['execute']>;
}

export async function runEvidenceQualification(input: QualificationConfig, directory: string, ports: EvidenceQualificationPorts) {
  const config = validateConfig(input);
  requireCheck(ports && ['inspect', 'execute', 'close'].every(key => typeof ports[key as keyof EvidenceQualificationPorts] === 'function'),
    'Owned qualification capabilities required');
  const writer = await createEvidenceWriter(directory);
  let inspectionComplete = false;
  let closeStarted = false;
  let closeComplete = false;
  let cleanupRecorded = false;
  let reportRecorded = false;
  let report: Awaited<ReturnType<typeof qualify>> | null = null;
  try {
    await writer.write('run.json', { version: 1, runId: config.candidate.runId, referenceRunId: config.reference.runId,
      runtimeAccepted: false, liveCapabilityAccepted: false, productionReady: false });
    report = await qualify(config, {
      inspect: async (c, deadline) => {
        await ports.inspect(c, deadline);
        deadline.check();
        inspectionComplete = true;
        await writer.write('inspection.json', { inspectionComplete });
      },
      execute: async (gate, c, deadline) => {
        let captureActive = true;
        try {
          const outcome = await ports.execute(gate, c, deadline, (file, value) => {
            requireCheck(captureActive, 'Gate evidence capture is closed');
            deadline.check();
            return writer.write(file, value);
          });
          deadline.check();
          requireCheck(outcome.gate === gate, 'Gate result substitution refused');
          await writer.settle();
          await writer.write(`gate-${gate.toLowerCase()}.json`, nonsecretEvidence(outcome));
          return outcome;
        } finally { captureActive = false; }
      },
      close: async deadline => {
        closeStarted = true;
        try {
          await ports.close(deadline);
          deadline.check();
          closeComplete = true;
        } finally {
          await writer.write('cleanup.json', { closeStarted, closeComplete, inspectionComplete });
          cleanupRecorded = true;
        }
      }
    });
    await writer.write('qualification.json', report);
    reportRecorded = true;
    const records = await writer.settle();
    await writer.write('evidence-index.json', { version: 1, runId: config.candidate.runId, records,
      observedGatesComplete: report.observedGatesComplete, inspectionComplete, closeStarted, closeComplete,
      runtimeAccepted: false, liveCapabilityAccepted: false, productionReady: false });
    writer.seal();
    await writer.settle();
    return report;
  } catch {
    try {
      await writer.write('failure.json', { failed: true, inspectionComplete, closeStarted, closeComplete,
        reportRecorded, runtimeAccepted: false, liveCapabilityAccepted: false, productionReady: false });
    } finally {
      if (!cleanupRecorded) {
        await writer.write('cleanup-final.json', { closeStarted, closeComplete, inspectionComplete });
      }
      writer.seal();
      await writer.settle();
    }
    throw new Error('Qualification evidence failed; preserve the private partial output directory');
  }
}
