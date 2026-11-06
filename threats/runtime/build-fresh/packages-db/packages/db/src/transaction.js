import { pool } from './client.js';
export async function withTransaction(operation, options = {}) {
    const begin = options.isolationLevel
        ? `BEGIN ISOLATION LEVEL ${options.isolationLevel}`
        : 'BEGIN';
    const client = await pool.connect();
    // Registered before the first statement: the backend can die at any point
    // after checkout, including before BEGIN is acknowledged.
    const swallowClientError = () => {
        // The rejected query already carries this error to the caller. Its only
        // other job here is to keep Node from treating it as unhandled.
    };
    client.on('error', swallowClientError);
    let connectionBroken = false;
    try {
        await client.query(begin);
        const result = await operation(client);
        await client.query('COMMIT');
        return result;
    }
    catch (error) {
        try {
            await client.query('ROLLBACK');
        }
        catch {
            // The backend is unreachable, so the transaction is already gone. Keep
            // the original error: the rollback failure is a symptom, not the cause.
            connectionBroken = true;
        }
        throw error;
    }
    finally {
        client.off('error', swallowClientError);
        client.release(connectionBroken);
    }
}
//# sourceMappingURL=transaction.js.map