import cluster from 'node:cluster';
import os from 'node:os';

const parsed = Number(process.env.API_WORKERS ?? Math.min(4, Math.max(2, os.availableParallelism())));
const workerCount = Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : 1;

if (cluster.isPrimary && workerCount > 1) {
  let shuttingDown = false;
  for (let i = 0; i < workerCount; i += 1) {
    cluster.fork();
  }
  cluster.on('exit', (worker, code, signal) => {
    if (!shuttingDown) {
      console.error(`[api-cluster] worker ${worker.process.pid} exited (code=${code}, signal=${signal}); restarting`);
      cluster.fork();
    }
  });
  const shutdown = (sig: NodeJS.Signals) => {
    shuttingDown = true;
    for (const id of Object.keys(cluster.workers ?? {})) {
      cluster.workers?.[id]?.process.kill(sig);
    }
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
} else {
  await import('./index.js');
}
