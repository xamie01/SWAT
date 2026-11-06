export class IngestionBatchError extends Error {
    result;
    constructor(message, result, options) {
        super(message, options);
        this.result = result;
        this.name = 'IngestionBatchError';
    }
}
export async function runTrackedIngestion(input, recorder) {
    const batchAt = new Date();
    let result;
    try {
        result = await input.run();
    }
    catch (error) {
        const failedResult = error instanceof IngestionBatchError
            ? error.result
            : {
                fetched: 0,
                inserted: 0,
                skipped: 0,
                failed: 1,
                lastEventAt: null
            };
        try {
            await recorder({
                chain: input.chain,
                source: input.source,
                batchAt,
                lastEventAt: failedResult.lastEventAt,
                inserted: failedResult.inserted,
                skipped: failedResult.skipped,
                failed: Math.max(1, failedResult.failed),
                errorMessage: error instanceof Error ? error.message : String(error)
            });
        }
        catch (recordError) {
            throw new AggregateError([error, recordError], `Ingestion and health recording both failed for ${input.chain}`);
        }
        throw error;
    }
    await recorder({
        chain: input.chain,
        source: input.source,
        batchAt,
        lastEventAt: result.lastEventAt,
        inserted: result.inserted,
        skipped: result.skipped,
        failed: result.failed
    });
    return result;
}
//# sourceMappingURL=ingestion-health.js.map