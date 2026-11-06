export declare const POSTGRES_INT8_OID = 20;
export declare const POSTGRES_NUMERIC_OID = 1700;
type PostgresTypeParserRegistry = {
    setTypeParser(oid: number, parser: (value: string) => unknown): void;
};
export declare function parsePostgresInt8(value: string): number | string;
export declare function parsePostgresNumeric(value: string): number | string;
export declare function configurePostgresNumericParsers(registry: PostgresTypeParserRegistry): void;
export {};
//# sourceMappingURL=numeric.d.ts.map