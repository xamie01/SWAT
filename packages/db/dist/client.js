import { Pool } from 'pg';
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
    throw new Error('DATABASE_URL is required');
}
export const pool = new Pool({ connectionString: databaseUrl });
export async function query(text, values) {
    const result = await pool.query(text, values);
    return result.rows;
}
//# sourceMappingURL=client.js.map