export const POSTGRES_INT8_OID = 20;
export const POSTGRES_NUMERIC_OID = 1700;
const MAX_SAFE_DECIMAL_SIGNIFICANT_DIGITS = 15;
const INTEGER_TEXT = /^[+-]?\d+$/;
const DECIMAL_TEXT = /^[+-]?\d+\.\d+$/;
export function parsePostgresInt8(value) {
    if (!INTEGER_TEXT.test(value))
        return value;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : value;
}
export function parsePostgresNumeric(value) {
    if (INTEGER_TEXT.test(value))
        return parsePostgresInt8(value);
    if (!DECIMAL_TEXT.test(value))
        return value;
    const unsigned = value.replace(/^[+-]/, '');
    const [integerPart, fractionalPart] = unsigned.split('.');
    // A decimal with only zero fractional digits is still an integer and must
    // obey the safe-integer boundary.
    if (/^0+$/.test(fractionalPart)) {
        const parsed = Number(value);
        return Number.isSafeInteger(parsed) ? parsed : value;
    }
    const significantDigits = `${integerPart}${fractionalPart}`
        .replace(/^0+/, '')
        .replace(/0+$/, '')
        .length;
    if (significantDigits > MAX_SAFE_DECIMAL_SIGNIFICANT_DIGITS)
        return value;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : value;
}
export function configurePostgresNumericParsers(registry) {
    registry.setTypeParser(POSTGRES_INT8_OID, parsePostgresInt8);
    registry.setTypeParser(POSTGRES_NUMERIC_OID, parsePostgresNumeric);
}
//# sourceMappingURL=numeric.js.map