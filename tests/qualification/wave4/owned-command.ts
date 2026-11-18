import { execFile, type ChildProcess } from 'node:child_process';
import { Deadline } from './containment.js';

export async function command(deadline: Deadline, file: string, args: string[], extra: Record<string, string> = {}, maxBuffer = 1024 * 1024) {
  const timeout = deadline.remaining();
  let child: ChildProcess | undefined;
  const release = deadline.enroll(() => { if (child?.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    let error: Error | null = null, output = { stdout: '', stderr: '' };
    try {
      child = execFile(file, args, { timeout, killSignal: 'SIGKILL', maxBuffer,
        env: { PATH: process.env.PATH, LANG: 'C', ...extra } }, (failure, stdout, stderr) => {
        error = failure;
        output = { stdout, stderr };
      });
      child.once('close', () => {
        release();
        try { deadline.check(); if (error) throw new Error('Owned command failed; private diagnostics required'); resolve(output); }
        catch (failure) { reject(failure); }
      });
    } catch {
      release();
      reject(new Error('Owned command spawn failed'));
    }
  });
}
