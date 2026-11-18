import { Deadline } from './containment.js';

interface ClientFactory {
  postgres(url: string, name: string, timeout: number): any;
  redis(url: string, name: string, timeout: number): any;
}
interface OwnedClient {
  stop(): Promise<void>;
  release(): void;
}

export class OwnedClients {
  private readonly clients = new Set<OwnedClient>();
  private readonly pending = new Set<Promise<unknown>>();
  private closing = false;
  constructor(private readonly deadline: Deadline, private readonly factory: ClientFactory) {}
  private track<T>(work: Promise<T>): Promise<T> {
    this.pending.add(work);
    void work.then(() => this.pending.delete(work), () => this.pending.delete(work));
    return work;
  }
  private async connect(c: any, kind: 'postgres' | 'redis') {
    let stopped: Promise<void> | undefined;
    const stop = () => {
      if (stopped) return stopped;
      if (kind === 'postgres') {
        const socket = c.connection.stream;
        const closed = socket.closed ? Promise.resolve() : new Promise<void>(resolve => socket.once('close', resolve));
        let ended: Promise<void>;
        try { ended = Promise.resolve(c.end()); }
        catch (error) { ended = Promise.reject(error); }
        stopped = Promise.allSettled([ended, closed]).then(results => {
          if (results.some(r => r.status === 'rejected')) throw new Error('Owned PostgreSQL shutdown failed');
        });
        // pg query timeouts reject locally; destroying this client's socket prevents queued work continuing.
        socket.destroy();
      } else {
        stopped = c.status === 'wait' || c.status === 'end' ? Promise.resolve() : new Promise<void>(resolve => c.once('end', resolve));
        c.disconnect(false);
      }
      void stopped.catch(() => {});
      return stopped;
    };
    const owned: OwnedClient = { stop, release: this.deadline.enroll(() => { void stop(); }) };
    this.clients.add(owned);
    c.on('error', () => {});
    const method = kind === 'postgres' ? 'query' : 'sendCommand';
    const original = c[method].bind(c);
    c[method] = (...args: unknown[]) => this.track((async () => {
      this.deadline.check();
      if (this.closing || stopped) throw new Error('Owned client already closing');
      try {
        const response = await original(...args);
        this.deadline.check();
        return response;
      } catch (error) {
        const code = String((error as { code?: string }).code ?? '');
        if (kind !== 'postgres' || !/^(?:[0-9]{2}|P0|XX)[0-9A-Z]{3}$/.test(code) || code.startsWith('08')) await stop();
        throw error;
      }
    })());
    await this.track(Promise.resolve(c.connect()));
    this.deadline.check();
    return c;
  }
  async postgres(url: string, name: string) {
    this.deadline.check();
    if (this.closing) throw new Error('Owned client already closing');
    return this.connect(this.factory.postgres(url, name, this.deadline.remaining(5000)), 'postgres');
  }
  async redis(url: string, name: string) {
    this.deadline.check();
    if (this.closing) throw new Error('Owned client already closing');
    return this.connect(this.factory.redis(url, name, this.deadline.remaining(5000)), 'redis');
  }
  async close(shutdown: Deadline) {
    shutdown.check();
    this.closing = true;
    const release = shutdown.enroll(() => { for (const client of this.clients) void client.stop(); });
    try {
      const stopped = await Promise.allSettled([...this.clients].map(client => client.stop()));
      await Promise.allSettled([...this.pending]);
      shutdown.check();
      if (stopped.some(r => r.status === 'rejected')) throw new Error('Owned client close failed');
    } finally {
      release();
      for (const client of this.clients) client.release();
      this.clients.clear();
    }
  }
}
