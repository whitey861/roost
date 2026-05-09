// Thin wrapper around child_process.spawn that captures stdout/stderr,
// supports timeout, and preserves the exit code. Keeps the rest of the
// worker code free of Node child_process plumbing.

import { spawn, type SpawnOptions } from 'node:child_process';

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
}

export async function execCapture(
  cmd: string,
  args: string[],
  opts: ExecOptions = {},
): Promise<ExecResult> {
  return new Promise<ExecResult>((resolve, reject) => {
    const spawnOpts: SpawnOptions = {
      cwd: opts.cwd,
      env: opts.env as NodeJS.ProcessEnv | undefined,
      stdio: ['pipe', 'pipe', 'pipe'],
    };
    const child = spawn(cmd, args, spawnOpts);

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let timer: NodeJS.Timeout | null = null;

    if (opts.timeoutMs && opts.timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        try { child.kill('SIGKILL'); } catch { /* ignore */ }
      }, opts.timeoutMs);
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      const s = chunk.toString('utf8');
      stdout += s;
      if (opts.onLog) {
        for (const line of s.split('\n')) {
          if (line.length > 0) opts.onLog(line);
        }
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      const s = chunk.toString('utf8');
      stderr += s;
      if (opts.onLog) {
        for (const line of s.split('\n')) {
          if (line.length > 0) opts.onLog(`[stderr] ${line}`);
        }
      }
    });

    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ exitCode: code ?? -1, stdout, stderr, timedOut });
    });

    if (opts.stdin !== undefined) {
      child.stdin?.write(opts.stdin);
      child.stdin?.end();
    } else {
      child.stdin?.end();
    }
  });
}
