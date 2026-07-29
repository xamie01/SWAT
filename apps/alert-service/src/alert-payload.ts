export type AlertSeverity = 'info' | 'warning' | 'high' | 'critical';

export type SignalAlertPayload = {
  kind: 'signal';
  signalId: string;
  pattern: string;
  tokenMint?: string;
  clusterId?: string;
  confidence?: number;
  score?: number;
  isSafe?: boolean;
  warnings?: string[];
  liquidity?: number | null;
  top10HolderPct?: number | null;
  buyerCount?: number;
  buyVolume?: number;
  exitVolume?: number;
  sellerCount?: number;
  clusterSize?: number;
  sellerPct?: number;
  soldToken?: string;
  boughtToken?: string;
  window?: string;
};

export type SystemAlertPayload = {
  kind: 'system';
  eventType: string;
  title: string;
  message: string;
  severity: AlertSeverity;
  chain?: string;
  requestedMode?: string;
  checkedAt?: string;
};

export type ExpectancyAlertPayload = {
  kind: 'expectancy';
  eventType: 'NIGHTLY_EXPECTANCY';
  title: string;
  message: string;
};

export type OperationalAlertPayload = SystemAlertPayload | ExpectancyAlertPayload;
export type AlertPayload = SignalAlertPayload | OperationalAlertPayload;

export class AlertPayloadValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AlertPayloadValidationError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredString(
  value: Record<string, unknown>,
  field: string,
  maxLength: number
): string {
  const candidate = value[field];
  if (typeof candidate !== 'string' || candidate.trim().length === 0) {
    throw new AlertPayloadValidationError(`${field} must be a non-empty string`);
  }
  if (candidate.length > maxLength) {
    throw new AlertPayloadValidationError(`${field} exceeds ${maxLength} characters`);
  }
  return candidate.trim();
}

function optionalString(
  value: Record<string, unknown>,
  field: string,
  maxLength: number
): string | undefined {
  if (value[field] === undefined) return undefined;
  return requiredString(value, field, maxLength);
}

function optionalFiniteNumber(
  value: Record<string, unknown>,
  field: string,
  nullable = false
): number | null | undefined {
  const candidate = value[field];
  if (candidate === undefined) return undefined;
  if (candidate === null && nullable) return null;
  if (typeof candidate !== 'number' || !Number.isFinite(candidate)) {
    throw new AlertPayloadValidationError(`${field} must be a finite number${nullable ? ' or null' : ''}`);
  }
  return candidate;
}

function parseSignalAlert(value: Record<string, unknown>): SignalAlertPayload {
  const payload: SignalAlertPayload = {
    kind: 'signal',
    signalId: requiredString(value, 'signalId', 128),
    pattern: requiredString(value, 'pattern', 64)
  };

  const stringFields = [
    'tokenMint',
    'clusterId',
    'soldToken',
    'boughtToken',
    'window'
  ] as const;
  for (const field of stringFields) {
    const candidate = optionalString(value, field, 512);
    if (candidate !== undefined) payload[field] = candidate;
  }

  const numberFields = [
    'confidence',
    'score',
    'buyerCount',
    'buyVolume',
    'exitVolume',
    'sellerCount',
    'clusterSize',
    'sellerPct'
  ] as const;
  for (const field of numberFields) {
    const candidate = optionalFiniteNumber(value, field);
    if (candidate !== undefined && candidate !== null) payload[field] = candidate;
  }

  const liquidity = optionalFiniteNumber(value, 'liquidity', true);
  if (liquidity !== undefined) payload.liquidity = liquidity;
  const top10HolderPct = optionalFiniteNumber(value, 'top10HolderPct', true);
  if (top10HolderPct !== undefined) payload.top10HolderPct = top10HolderPct;

  if (value.isSafe !== undefined) {
    if (typeof value.isSafe !== 'boolean') {
      throw new AlertPayloadValidationError('isSafe must be a boolean');
    }
    payload.isSafe = value.isSafe;
  }

  if (value.warnings !== undefined) {
    if (
      !Array.isArray(value.warnings) ||
      value.warnings.length > 50 ||
      value.warnings.some((warning) => typeof warning !== 'string' || warning.length > 500)
    ) {
      throw new AlertPayloadValidationError('warnings must be an array of at most 50 strings');
    }
    payload.warnings = [...value.warnings];
  }

  return payload;
}

const SEVERITIES = new Set<AlertSeverity>(['info', 'warning', 'high', 'critical']);
const EVENT_TYPE_PATTERN = /^[A-Z][A-Z0-9_]{2,79}$/;

function parseOperationalAlert(
  value: Record<string, unknown>,
  eventTypeField: 'type' | 'eventType'
): OperationalAlertPayload {
  const eventType = requiredString(value, eventTypeField, 80);
  if (!EVENT_TYPE_PATTERN.test(eventType)) {
    throw new AlertPayloadValidationError(`${eventTypeField} must be an uppercase event identifier`);
  }

  const title = requiredString(value, 'title', 200);
  const message = requiredString(value, 'message', 12_000);
  if (eventType === 'NIGHTLY_EXPECTANCY') {
    return { kind: 'expectancy', eventType, title, message };
  }

  const severityValue = requiredString(value, 'severity', 16);
  if (!SEVERITIES.has(severityValue as AlertSeverity)) {
    throw new AlertPayloadValidationError('severity must be info, warning, high, or critical');
  }

  const checkedAt = optionalString(value, 'checkedAt', 64);
  if (checkedAt !== undefined && !Number.isFinite(Date.parse(checkedAt))) {
    throw new AlertPayloadValidationError('checkedAt must be a valid timestamp');
  }

  return {
    kind: 'system',
    eventType,
    title,
    message,
    severity: severityValue as AlertSeverity,
    chain: optionalString(value, 'chain', 64),
    requestedMode: optionalString(value, 'requestedMode', 64),
    checkedAt
  };
}

export function parsePublishedAlertMessage(message: string): OperationalAlertPayload {
  let value: unknown;
  try {
    value = JSON.parse(message);
  } catch {
    throw new AlertPayloadValidationError('published alert is not valid JSON');
  }
  if (!isRecord(value)) {
    throw new AlertPayloadValidationError('published alert must be a JSON object');
  }
  return parseOperationalAlert(value, 'type');
}

export function parseQueuedAlertPayload(value: unknown): AlertPayload {
  if (!isRecord(value)) {
    throw new AlertPayloadValidationError('queued alert must be an object');
  }

  if (value.kind === 'signal' || (value.kind === undefined && value.signalId !== undefined)) {
    return parseSignalAlert(value);
  }
  if (value.kind === 'system' || value.kind === 'expectancy') {
    const parsed = parseOperationalAlert(value, 'eventType');
    if (value.kind !== parsed.kind) {
      throw new AlertPayloadValidationError('alert kind does not match its event type');
    }
    return parsed;
  }

  throw new AlertPayloadValidationError('queued alert has an unsupported kind');
}

export function escapeTelegramHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeTelegramHtmlWithin(value: string, maxLength: number): string {
  let escaped = '';
  for (const character of value) {
    const encoded = escapeTelegramHtml(character);
    if (escaped.length + encoded.length > maxLength - 3) return `${escaped}...`;
    escaped += encoded;
  }
  return escaped;
}

export function formatOperationalAlert(payload: OperationalAlertPayload): string {
  if (payload.kind === 'expectancy') {
    return [
      '<b>SWAT NIGHTLY EXPECTANCY</b>',
      `<b>${escapeTelegramHtmlWithin(payload.title, 400)}</b>`,
      '',
      escapeTelegramHtmlWithin(payload.message, 3_200)
    ].join('\n');
  }

  const context = (value: string) => escapeTelegramHtmlWithin(value, 192);
  const lines = [
    `<b>SWAT ${payload.severity.toUpperCase()} SYSTEM ALERT</b>`,
    `<b>${escapeTelegramHtmlWithin(payload.title, 400)}</b>`,
    `<b>Event:</b> <code>${escapeTelegramHtml(payload.eventType)}</code>`,
    `<b>Severity:</b> ${payload.severity.toUpperCase()}`
  ];
  if (payload.chain) lines.push(`<b>Chain:</b> ${context(payload.chain)}`);
  if (payload.requestedMode) {
    lines.push(`<b>Requested mode:</b> ${context(payload.requestedMode)}`);
  }
  if (payload.checkedAt) lines.push(`<b>Checked at:</b> ${context(payload.checkedAt)}`);
  lines.push('', escapeTelegramHtmlWithin(payload.message, 2_400));
  return lines.join('\n');
}
