import { describe, expect, it, vi } from 'vitest';
import {
  configurePostgresNumericParsers,
  parsePostgresInt8,
  parsePostgresNumeric,
  POSTGRES_INT8_OID,
  POSTGRES_NUMERIC_OID
} from './numeric.js';

describe('PostgreSQL numeric normalization', () => {
  it('converts safe INT8 values and preserves unsafe integers exactly', () => {
    expect(parsePostgresInt8('42')).toBe(42);
    expect(parsePostgresInt8('-9007199254740991')).toBe(-9007199254740991);
    expect(parsePostgresInt8('9007199254740992')).toBe('9007199254740992');
    expect(parsePostgresInt8('not-an-integer')).toBe('not-an-integer');
  });

  it('converts ordinary NUMERIC metrics without stripping meaningful values', () => {
    expect(parsePostgresNumeric('0.8750')).toBe(0.875);
    expect(parsePostgresNumeric('-12345.6789')).toBe(-12345.6789);
    expect(parsePostgresNumeric('0.000000000000001')).toBe(0.000000000000001);
    expect(parsePostgresNumeric('9007199254740991.0')).toBe(9007199254740991);
  });

  it('preserves high-precision and unsafe NUMERIC values as strings', () => {
    expect(parsePostgresNumeric('0.1234567890123456')).toBe('0.1234567890123456');
    expect(parsePostgresNumeric('9007199254740992.0')).toBe('9007199254740992.0');
    expect(parsePostgresNumeric('10000000000000000.1')).toBe('10000000000000000.1');
    expect(parsePostgresNumeric('NaN')).toBe('NaN');
  });

  it('registers parsers for PostgreSQL INT8 and NUMERIC OIDs', () => {
    const setTypeParser = vi.fn();
    configurePostgresNumericParsers({ setTypeParser });

    expect(setTypeParser).toHaveBeenNthCalledWith(
      1,
      POSTGRES_INT8_OID,
      parsePostgresInt8
    );
    expect(setTypeParser).toHaveBeenNthCalledWith(
      2,
      POSTGRES_NUMERIC_OID,
      parsePostgresNumeric
    );
  });
});
