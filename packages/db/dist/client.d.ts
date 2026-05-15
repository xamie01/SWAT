import { Pool, type QueryResultRow } from 'pg';
export declare const pool: Pool;
export declare function query<T extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]): Promise<T[]>;
//# sourceMappingURL=client.d.ts.map