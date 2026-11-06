import type { FastifyInstance } from 'fastify';
import '@fastify/cookie';
import type { Redis } from 'ioredis';
export interface AuthRouteOptions {
    readonly redis: Redis;
    readonly isProduction: boolean;
    /** Origin this server accepts sign-in messages for. Bound into every nonce. */
    readonly domain: string;
    readonly uri: string;
    readonly allowedOrigins?: readonly string[];
}
export declare function registerAuthRoutes(app: FastifyInstance, options: AuthRouteOptions): Promise<void>;
//# sourceMappingURL=routes.d.ts.map