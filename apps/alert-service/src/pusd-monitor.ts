import {
  assessPusdWithdrawalPath,
  type PusdMonitorInput,
  type PusdMonitorVerdict
} from '@swat/shared';

export interface PusdMonitorDependencies {
  readonly loadInputs: () => Promise<PusdMonitorInput>;
  readonly sendAlert: (message: string) => Promise<void>;
  readonly logError?: (message: string, error: unknown) => void;
  readonly onVerdict?: (verdict: PusdMonitorVerdict) => Promise<void>;
}

export function formatPusdOpsMessage(verdict: PusdMonitorVerdict): string {
  const isImpaired = verdict.outcome === 'impaired';
  const heading = isImpaired
    ? 'SWAT PUSD WITHDRAWAL IMPAIRMENT ALERT'
    : 'SWAT PUSD WITHDRAWAL STATUS';

  const lines = [
    `<b>${heading}</b>`,
    '',
    `<b>Outcome:</b> ${verdict.outcome.toUpperCase()}`,
    `<b>Reason Code:</b> ${verdict.reasonCode}`,
    `<b>Detail:</b> ${verdict.detail}`
  ];

  if (verdict.failures.length > 0) {
    lines.push(`<b>Failures:</b> ${verdict.failures.join(', ')}`);
  }
  if (verdict.unassessed.length > 0) {
    lines.push(`<b>Unassessed:</b> ${verdict.unassessed.join(', ')}`);
  }

  return lines.join('\n');
}

/**
 * Polls and assesses pUSD withdrawal-pool liquidity and offramp health (`S4-M42`).
 *
 * Dispatches Telegram operational alerts when `outcome === 'impaired'`.
 */
export async function checkPusdLiquidity(
  dependencies: PusdMonitorDependencies
): Promise<PusdMonitorVerdict | null> {
  try {
    const input = await dependencies.loadInputs();
    const verdict = assessPusdWithdrawalPath(input);
    if (verdict.outcome === 'impaired') {
      await dependencies.sendAlert(formatPusdOpsMessage(verdict));
    }
    await dependencies.onVerdict?.(verdict);
    return verdict;
  } catch (error) {
    dependencies.logError?.('[alert-service] pUSD liquidity check failed', error);
    return null;
  }
}
