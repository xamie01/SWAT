import { divideDecimalText, multiplyDecimalText } from './quote-valuation.js';

/** Bounded unsigned decimal ledger arithmetic. Never coerce economics to Number. */
export function exactDecimal(value: unknown, positive = false): string {
  if (typeof value !== 'string' || value.length > 256 || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)
    || (positive && !/[1-9]/.test(value))) throw new Error('Exact decimal unavailable');
  return value;
}
function parts(value: string) {
  exactDecimal(value);
  const [whole, fraction = ''] = value.split('.');
  return { digits: BigInt(whole! + fraction), scale: fraction.length };
}
function aligned(left: string, right: string) {
  const a = parts(left), b = parts(right), scale = Math.max(a.scale, b.scale);
  return { a: a.digits * 10n ** BigInt(scale - a.scale), b: b.digits * 10n ** BigInt(scale - b.scale), scale };
}
function text(digits: bigint, scale: number): string {
  const value = digits.toString().padStart(scale + 1, '0');
  return scale ? `${value.slice(0, -scale)}.${value.slice(-scale)}`.replace(/0+$/, '').replace(/\.$/, '') : value;
}
export function compareExactDecimal(left: string, right: string): number {
  const { a, b } = aligned(left, right); return a < b ? -1 : a > b ? 1 : 0;
}
export function addExactDecimal(left: string, right: string): string {
  const { a, b, scale } = aligned(left, right); return text(a + b, scale);
}
export function subtractExactDecimal(left: string, right: string): string {
  const { a, b, scale } = aligned(left, right);
  if (a < b) throw new Error('Exact decimal underflow');
  return text(a - b, scale);
}
export function minimumExactDecimal(...values: string[]): string {
  if (!values.length) throw new Error('Exact minimum unavailable');
  return values.map(value => exactDecimal(value)).reduce((a, b) => compareExactDecimal(a, b) <= 0 ? a : b);
}
export function floorExactDecimal(value: string, scale: number): string {
  if (!Number.isSafeInteger(scale) || scale < 0 || scale > 36) throw new Error('Exact asset scale unavailable');
  return divideDecimalText(exactDecimal(value), '1', scale)!;
}
export { multiplyDecimalText, divideDecimalText };
