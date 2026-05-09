// Thin wrapper around child_process.spawn that captures stdout/stderr,
// supports timeout, and preserves the exit code. Keeps the rest of the
// worker code free of Node child_process plumbing.
//
// Hardening notes:
//   - Every stdio stream gets an `error` listener. A child that exits before
//     we finish writing stdin would otherwise emit `EPIPE` on `child.stdin`
//     with no listener, which crashes the parent process via Node's default
//     unhandled-error behaviour. The worker has been seen dying with exit
//     code 128 ~30s after spawning `claude`; that pattern fits an EPIPE we
//     never observed.
//   - We never throw out of the returned promise. All failures resolve with
//     a structured ExecResult so callers can decide what to do, and the
//     worker process is insulated from child-process events.
//   - The promise resolves exactly once. `child.on('error')` and
//     `child.on('close')` can both fire; we guard against double-resolve.

import { spawn, type SpawnOptions, type ChildProcess } from 'node:child_process';

export interface ExecOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  onLog?: (line: string) => void;
  // Pass stdin payload (e.g. for `claude --print < prompt.md` scenarios).
  stdin?: string;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  // Signal that terminated the child (SIGKILL when we time out, etc.).
  signal: NodeJS.Signals | null;
  // Populated when spawn itself failed or a stdio stream emitted an error.
  // `exitCode` will be -1 in the spawn-failure case.
  spawnError: string | null;
}

export async function execCapture(
  cmd: string,
  args: string[],
  opts: ExecOptions = {},
): Promise<ExecResult> {
  return new Promise<ExecResult>((resolve) => {
    const safeLog = (line: string): void => {
      if (!opts.onLog || line.length === 0) return;
      try {
        opts.onLog(line);
      } catch {
        // The logger itself failed. There is nothing useful we can do here
        // except not crash the worker.
      }
    };

    const spawnOpts: SpawnOptions = {
      cwd: opts.cwd,
      env: opts.env as NodeJS.ProcessEnv | undefined,
      stdio: ['pipe', 'pipe', 'pipe'],
    };

    let child: ChildProcess;
    try {
      child = spawn(cmd, args, spawnOpts);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      safeLog(`[exec] spawn(${cmd}) threw: ${message}`);
      resolve({
        exitCode: -1,
        stdout: '',
        stderr: '',
        timedOut: false,
        signal: null,
        spawnError: message,
      });
      return;
    }

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let exitSignal: NodeJS.Signals | null = null;
    let spawnError: string | null = null;
    let timer: NodeJS.Timeout | null = null;
    let done = false;

    const finish = (result: Omit<ExecResult, 'spawnError'>): void => {
      if (done) return;
      done = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      resolve({ ...result, spawnError });
    };

    if (opts.timeoutMs && opts.timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        try {
          child.kill('SIGKILL');
        } catch (err) {
          safeLog(
            `[exec] kill(${cmd}) failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }, opts.timeoutMs);
    }

    const handleStreamError = (which: string) => (err: Error): void => {
      // EPIPE on stdin is expected when the child exits before we finish
      // writing. Capture it so the caller can see what happened, but never
      // let it bubble up as an unhandled error event.
      const message = `${which}: ${err.message}`;
      safeLog(`[exec] ${cmd} ${message}`);
      if (!spawnError) spawnError = message;
    };

    if (child.stdout) {
      child.stdout.on('data', (chunk: Buffer) => {
        const s = chunk.toString('utf8');
        stdout += s;
        if (opts.onLog) {
          for (const line of s.split('\n')) {
            if (line.length > 0) safeLog(line);
          }
        }
      });
      child.stdout.on('error', handleStreamError('stdout'));
    }
    if (child.stderr) {
      child.stderr.on('data', (chunk: Buffer) => {
        const s = chunk.toString('utf8');
        stderr += s;
        if (opts.onLog) {
          for (const line of s.split('\n')) {
            if (line.length > 0) safeLog(`[stderr] ${line}`);
          }
        }
      });
      child.stderr.on('error', handleStreamError('stderr'));
    }
    if (child.stdin) {
      child.stdin.on('error', handleStreamError('stdin'));
    }

    child.on('error', (err) => {
      const message = err instanceof Error ? err.message : String(err);
      if (!spawnError) spawnError = message;
      safeLog(`[exec] ${cmd} child error: ${message}`);
      finish({ exitCode: -1, stdout, stderr, timedOut, signal: exitSignal });
    });

    child.on('close', (code, signal) => {
      exitSignal = signal;
      finish({ exitCode: code ?? -1, stdout, stderr, timedOut, signal: exitSignal });
    });

    if (opts.stdin !== undefined && child.stdin) {
      const stdin = child.stdin;
      const payload = opts.stdin;
      // write() takes a callback that fires once the chunk is flushed or the
      // write fails. Using it lets us capture EPIPE without relying on the
      // 'error' event alone.
      try {
        stdin.write(payload, (err) => {
          if (err) {
            const message = `stdin.write: ${err.message}`;
            if (!spawnError) spawnError = message;
            safeLog(`[exec] ${cmd} ${message}`);
          }
          try {
            stdin.end();
          } catch (endErr) {
            const message = endErr instanceof Error ? endErr.message : String(endErr);
            if (!spawnError) spawnError = `stdin.end: ${message}`;
            safeLog(`[exec] ${cmd} stdin.end threw: ${message}`);
          }
        });
      } catch (writeErr) {
        const message = writeErr instanceof Error ? writeErr.message : String(writeErr);
        if (!spawnError) spawnError = `stdin.write: ${message}`;
        safeLog(`[exec] ${cmd} stdin.write threw: ${message}`);
        try {
          stdin.end();
        } catch {
          // Already in a bad state; the close handler will fire shortly.
        }
      }
    } else if (child.stdin) {
      try {
        child.stdin.end();
      } catch {
        // Stdin was already closed by the child. Nothing to do.
      }
    }
  });
}
