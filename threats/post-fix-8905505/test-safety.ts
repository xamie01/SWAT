import { vi } from 'vitest';

vi.mock('pg', () => {
  class Pool {
    query() { throw new Error('POST_FIX_REVIEW_DATABASE_BLOCKED'); }
    connect() { throw new Error('POST_FIX_REVIEW_DATABASE_BLOCKED'); }
    on() { return this; }
    end() { return Promise.resolve(); }
  }
  const types = { setTypeParser() {} };
  return { Pool, types, default: { Pool, types } };
});

vi.mock('ioredis', () => {
  class Redis {
    constructor() { throw new Error('POST_FIX_REVIEW_REDIS_BLOCKED'); }
  }
  return { default: Redis, Redis };
});
