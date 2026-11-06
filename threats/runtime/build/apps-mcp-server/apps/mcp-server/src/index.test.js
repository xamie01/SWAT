import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
    handlers: [],
    listen: vi.fn(),
    publish: vi.fn(async () => 1),
    query: vi.fn(async () => [])
}));
vi.mock('@modelcontextprotocol/sdk/server/index.js', () => ({
    Server: class {
        setRequestHandler(_schema, handler) {
            mocks.handlers.push(handler);
        }
        async connect() { }
    }
}));
vi.mock('@modelcontextprotocol/sdk/server/sse.js', () => ({
    SSEServerTransport: class {
        async handlePostMessage() { }
    }
}));
vi.mock('express', () => ({
    default: () => ({
        get: vi.fn(),
        post: vi.fn(),
        listen: mocks.listen
    })
}));
vi.mock('ioredis', () => ({
    Redis: class {
        publish = mocks.publish;
    }
}));
vi.mock('@swat/db', () => ({
    pool: { connect: vi.fn() },
    query: mocks.query,
    resolvePrefixedAddress: vi.fn(async (address) => address)
}));
vi.mock('@swat/shared', () => ({
    initLogger: vi.fn(),
    REDIS_CHANNELS: { scorerRun: 'swat:scorer:run' }
}));
beforeAll(async () => {
    await import('./index.js');
});
beforeEach(() => {
    mocks.publish.mockClear();
    mocks.query.mockClear();
});
describe('MCP server contract', () => {
    it('registers the expected tools and starts the HTTP transport', async () => {
        const response = await mocks.handlers[0]({});
        expect(response.tools.map((tool) => tool.name)).toEqual([
            'get_recent_signals',
            'get_wallet_score',
            'get_performance',
            'get_blacklist',
            'add_to_blacklist',
            'remove_from_blacklist',
            'trigger_scorer'
        ]);
        expect(response.tools.find((tool) => tool.name === 'get_wallet_score')?.inputSchema.required)
            .toEqual(['walletAddress']);
        expect(mocks.listen).toHaveBeenCalledWith(3005, '0.0.0.0', expect.any(Function));
    });
    it('bounds recent-signal queries without contacting PostgreSQL', async () => {
        await mocks.handlers[1]({
            params: { name: 'get_recent_signals', arguments: { limit: 500 } }
        });
        expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining('FROM signals'), [50]);
    });
    it('publishes scorer requests to the configured Redis channel', async () => {
        const response = await mocks.handlers[1]({
            params: { name: 'trigger_scorer', arguments: {} }
        });
        expect(mocks.publish).toHaveBeenCalledWith('swat:scorer:run', '{}');
        expect(response).toEqual({
            content: [{
                    type: 'text',
                    text: 'Successfully published scorer run command to Redis channel.'
                }]
        });
    });
    it('returns an MCP error result for an unknown tool', async () => {
        const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const response = await mocks.handlers[1]({
            params: { name: 'not_a_tool', arguments: {} }
        });
        expect(response).toEqual({
            isError: true,
            content: [{ type: 'text', text: 'Error: Unknown tool: not_a_tool' }]
        });
        error.mockRestore();
    });
});
//# sourceMappingURL=index.test.js.map