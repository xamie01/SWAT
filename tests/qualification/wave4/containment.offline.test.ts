import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Deadline, tmpfsBytes } from './containment.js';
import { OwnedClients } from './owned-clients.js';
import { command } from './owned-command.js';
import { qualify, result, assertion } from './core.js';
import { config } from './offline-fixture.js';
import { privateConfig } from './config.js';
import { ownedWorker } from './faults.js';

const mocks = vi.hoisted(() => ({ exec: vi.fn(), fork: vi.fn(), lstat: vi.fn(), open: vi.fn() }));
vi.mock('node:child_process', () => ({ execFile: mocks.exec, fork: mocks.fork }));
vi.mock('node:fs/promises', () => ({ lstat: mocks.lstat, open: mocks.open }));

afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });
function postgres() {
  const c: any = new EventEmitter();
  c.connect = vi.fn(async () => {});
  c.query = vi.fn(async () => ({ rows: [] }));
  c.end = vi.fn(async () => {});
  const socket: any = new EventEmitter();
  socket.closed = false;
  socket.destroy = vi.fn(() => { socket.closed = true; socket.emit('close'); });
  c.connection = { stream: socket };
  return c;
}
function factory(c: any) { return { postgres: vi.fn(() => c), redis: vi.fn(() => c) }; }
function shutdown() { return new Deadline(5000); }

describe('owned containment offline contracts; no processes or sockets', () => {
  it.each([0, -1, 600001, NaN, 1.5])('rejects invalid deadline %s', value => {
    expect(() => new Deadline(value)).toThrow();
  });
  it('uses monotonic elapsed time rather than wall-clock changes', async () => {
    vi.useFakeTimers();
    const d = new Deadline(100);
    vi.setSystemTime(Date.now() + 1_000_000);
    expect(d.remaining(50)).toBe(50);
    await vi.advanceTimersByTimeAsync(101);
    expect(() => d.check()).toThrow(); d.dispose();
  });
  it('cancels only enrolled handles once, tolerates failed cancel and honors release', () => {
    const d = new Deadline(1000), kept = vi.fn(), removed = vi.fn();
    d.enroll(() => { throw new Error('cancel'); });
    d.enroll(kept); d.enroll(removed)();
    d.abort(); d.abort(); d.dispose();
    expect(kept).toHaveBeenCalledOnce(); expect(removed).not.toHaveBeenCalled();
    expect(() => d.enroll(vi.fn())).toThrow();
  });
  it.each([['size=4096',4096],['rw,size=64m,nosuid',64*1024**2],['size=2G',2*1024**3]])('parses numeric tmpfs bound %s', (options, bytes) => {
    expect(tmpfsBytes(options as string)).toBe(bytes);
  });
  it.each(['rw','size=0','size=1','size=3g','size=999999999999999999999m','size=2m,size=3m','size=2m,SIZE=3m','size=02m','size=2mb','size=-2m','size=2.5m'])('rejects tmpfs declaration %s', value => {
    expect(() => tmpfsBytes(value)).toThrow();
  });
  it('closes owned PostgreSQL and settles an in-flight query before qualification returns', async () => {
    vi.useFakeTimers();
    const c = postgres(), events: string[] = [];
    let rejectQuery!: (error: Error) => void;
    c.query = vi.fn(() => new Promise((_, reject) => { rejectQuery = reject; }));
    c.connection.stream.destroy = vi.fn(() => {
      events.push('destroy'); c.connection.stream.closed = true; c.connection.stream.emit('close'); rejectQuery(new Error('closed'));
    });
    const f = factory(c); let clients!: OwnedClients;
    const input = { ...config(), maxDurationMs: 10_000 };
    const work = qualify(input, {
      inspect: async (_, d) => { clients = new OwnedClients(d, f); await clients.postgres('synthetic', 'owned'); },
      execute: async () => { await c.query('blocked'); return result('I1', [assertion('unreachable',true)]); },
      close: async d => { await clients.close(d); events.push('closed'); }
    }).then(r => { events.push('returned'); return r; });
    await vi.advanceTimersByTimeAsync(10_001);
    const r = await work;
    expect(r.results).toEqual([]); expect(r.failure).not.toBeNull();
    expect(events).toEqual(['destroy','closed','returned']); expect(c.end).toHaveBeenCalledOnce();
    await expect(c.query('late')).rejects.toThrow(); expect(f.postgres).toHaveBeenCalledOnce();
  });
  it('PostgreSQL end alone is insufficient without owned socket close', async () => {
    const d = new Deadline(1000), s = shutdown(), c = postgres();
    c.connection.stream.destroy = vi.fn();
    const clients = new OwnedClients(d, factory(c)); await clients.postgres('synthetic','owned');
    d.abort(); let settled = false;
    const work = clients.close(s).then(() => { settled = true; });
    await Promise.resolve(); await Promise.resolve(); expect(settled).toBe(false);
    c.connection.stream.closed = true; c.connection.stream.emit('close'); await work;
    expect(settled).toBe(true); d.dispose(); s.dispose();
  });
  it('local PostgreSQL query timeout closes socket before exposing rejection', async () => {
    const d = new Deadline(1000), s = shutdown(), c = postgres();
    c.query = vi.fn(async () => { throw new Error('Query read timeout'); });
    const clients = new OwnedClients(d, factory(c));
    await clients.postgres('synthetic', 'owned');
    await expect(c.query('query')).rejects.toThrow();
    expect(c.connection.stream.destroy).toHaveBeenCalledOnce();
    await clients.close(s); d.dispose(); s.dispose();
  });
  it.each(['EPIPE','08006'])('transport failure %s closes socket rather than being classified as a constraint rejection', async code => {
    const d = new Deadline(1000), s = shutdown(), c = postgres();
    c.query = vi.fn(async () => { throw {code}; });
    const clients = new OwnedClients(d,factory(c)); await clients.postgres('synthetic','owned');
    await expect(c.query('query')).rejects.toEqual({code}); expect(c.connection.stream.destroy).toHaveBeenCalledOnce();
    await clients.close(s); d.dispose(); s.dispose();
  });
  it('canonical PostgreSQL constraint rejection does not destroy a valid transaction', async () => {
    const d = new Deadline(1000), s = shutdown(), c = postgres();
    c.query = vi.fn(async () => { throw { code:'23505' }; });
    const clients = new OwnedClients(d, factory(c));
    await clients.postgres('synthetic', 'owned');
    await expect(c.query('query')).rejects.toEqual({code:'23505'});
    expect(c.end).not.toHaveBeenCalled();
    await clients.close(s); d.dispose(); s.dispose();
  });
  it('Redis abort disconnects without reconnect and waits for end', async () => {
    const d = new Deadline(1000), s = shutdown(), c: any = new EventEmitter();
    c.status = 'ready'; c.connect = vi.fn(async () => {}); c.sendCommand = vi.fn(async () => 'OK');
    c.disconnect = vi.fn((reconnect: boolean) => { expect(reconnect).toBe(false); c.status = 'end'; c.emit('end'); });
    const clients = new OwnedClients(d, factory(c));
    await clients.redis('synthetic', 'owned'); d.abort(); await clients.close(s);
    expect(c.disconnect).toHaveBeenCalledOnce(); await expect(c.sendCommand('late')).rejects.toThrow();
    d.dispose(); s.dispose();
  });
  it('failed connection is retained for owned cleanup and later opens are refused', async () => {
    const d = new Deadline(1000), s = shutdown(), c = postgres(), f = factory(c);
    c.connect = vi.fn(async () => { throw new Error('connection'); });
    const clients = new OwnedClients(d, f);
    await expect(clients.postgres('synthetic','owned')).rejects.toThrow();
    d.abort(); await clients.close(s);
    await expect(clients.postgres('synthetic','late')).rejects.toThrow();
    expect(c.end).toHaveBeenCalledOnce(); expect(f.postgres).toHaveBeenCalledOnce(); d.dispose(); s.dispose();
  });
  it('owned command cancellation waits for close rather than just the callback', async () => {
    const d = new Deadline(1000), child: any = new EventEmitter();
    child.exitCode = null; child.signalCode = null; child.kill = vi.fn();
    let callback!: (...args: any[]) => void;
    mocks.exec.mockImplementation((_file, _args, _options, cb) => { callback = cb; return child; });
    let settled = false;
    const work = command(d,'inert',[]).catch(error => { settled = true; return error; });
    d.abort(); callback(new Error('private secret'), '', 'private secret');
    await Promise.resolve(); expect(settled).toBe(false);
    child.emit('close',null,'SIGKILL'); expect((await work).message).not.toContain('secret');
    expect(child.kill).toHaveBeenCalledWith('SIGKILL'); d.dispose();
  });
  it('successful command also waits for close and uses finite timeout and private environment', async () => {
    const d = new Deadline(1000), child: any = new EventEmitter();
    child.exitCode = null; child.signalCode = null; child.kill = vi.fn();
    let callback!: (...args: any[]) => void;
    mocks.exec.mockImplementation((_file, _args, options, cb) => {
      expect(options.timeout).toBeLessThanOrEqual(1000); expect(options.killSignal).toBe('SIGKILL');
      expect(options.env).not.toHaveProperty('DATABASE_URL'); callback = cb; return child;
    });
    let settled = false;
    const work = command(d,'inert',[]).then(r => { settled = true; return r; });
    callback(null,'output',''); await Promise.resolve(); expect(settled).toBe(false);
    child.exitCode = 0; child.emit('close',0,null); expect((await work).stdout).toBe('output'); d.dispose();
    expect(child.kill).not.toHaveBeenCalled();
  });
  it('expired command does not spawn anything', async () => {
    const d = new Deadline(1000); d.abort();
    await expect(command(d,'inert',[])).rejects.toThrow(); expect(mocks.exec).not.toHaveBeenCalled(); d.dispose();
  });
  it.each(['cancel','send-error','wrong-run','duplicate-ack'])('owned child %s rejects only after close', async mode => {
    const d = new Deadline(1000), child: any = new EventEmitter();
    child.pid = 123; child.exitCode = null; child.signalCode = null; child.kill = vi.fn();
    let callback!: (error?: Error) => void;
    child.send = vi.fn((_input, cb) => { callback = cb; });
    mocks.fork.mockReturnValue(child);
    const input = { configPath:'/inert/private.json',runId:config().candidate.runId,
      userId:config().candidate.runId,operationId:config().reference.runId,point:'none' as const };
    let settled = false;
    const work = ownedWorker(input,d).catch(error => { settled = true; return error; });
    const ack = { kind:'ack',operationId:input.operationId,runId:input.runId };
    if (mode === 'cancel') d.abort();
    if (mode === 'send-error') callback(new Error('send'));
    if (mode === 'wrong-run') child.emit('message',{...ack,runId:'foreign'});
    if (mode === 'duplicate-ack') { child.emit('message',ack); child.emit('message',ack); }
    await Promise.resolve(); expect(settled).toBe(false); expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    child.emit('close',null,'SIGKILL'); expect(await work).toBeInstanceOf(Error); d.dispose();
  });
  it('asynchronous child spawn failure without a PID is handled without unhandled error', async () => {
    const d = new Deadline(1000), child: any = new EventEmitter();
    child.pid = undefined; child.exitCode = null; child.signalCode = null; child.kill = vi.fn(); child.send = vi.fn();
    mocks.fork.mockReturnValue(child);
    const work = ownedWorker({configPath:'/inert/private.json',runId:config().candidate.runId,userId:config().candidate.runId,
      operationId:config().reference.runId,point:'none'},d);
    const error = new Error('spawn'); child.emit('error',error);
    await expect(work).rejects.toBe(error); d.dispose();
  });
  it('owned child enrollment expiry after spawn still kills and reaps', async () => {
    const d = new Deadline(1000), child: any = new EventEmitter();
    child.pid = 123; child.exitCode = null; child.signalCode = null; child.kill = vi.fn(); child.send = vi.fn();
    mocks.fork.mockImplementation(() => { d.abort(); return child; });
    let settled = false;
    const work = ownedWorker({configPath:'/inert/private.json',runId:config().candidate.runId,userId:config().candidate.runId,
      operationId:config().reference.runId,point:'none'},d).catch(error => { settled = true; return error; });
    await Promise.resolve(); expect(settled).toBe(false); expect(child.send).not.toHaveBeenCalled();
    expect(child.kill).toHaveBeenCalledWith('SIGKILL'); child.emit('close',null,'SIGKILL'); await work; d.dispose();
  });
  it('private config refuses a changed opened owner before reading', async () => {
    const stat = { isFile:()=>true,isSymbolicLink:()=>false,uid:process.getuid?.(),mode:0o600,dev:1,ino:1,size:10 };
    const read = vi.fn(), close = vi.fn(async()=>{});
    mocks.lstat.mockResolvedValue(stat); mocks.open.mockResolvedValue({stat:async()=>({...stat,uid:-1}),read,close});
    await expect(privateConfig('/inert/private.json')).rejects.toThrow(/changed/);
    expect(read).not.toHaveBeenCalled(); expect(close).toHaveBeenCalledOnce();
  });
});
