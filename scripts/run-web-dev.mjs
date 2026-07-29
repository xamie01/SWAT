import { spawn } from 'node:child_process';

const host = process.env.WEB_BIND_HOST ?? '0.0.0.0';
const port = Number(process.env.WEB_PORT ?? 3000);

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error(`WEB_PORT must be an integer between 1 and 65535; received ${process.env.WEB_PORT}`);
  process.exit(1);
}

const child = spawn(
  process.execPath,
  ['node_modules/next/dist/bin/next', 'dev', '-H', host, '-p', String(port)],
  { stdio: 'inherit', env: process.env }
);

child.on('error', (error) => {
  console.error('Failed to start the Next.js development server', error);
  process.exitCode = 1;
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exitCode = code ?? 1;
});
