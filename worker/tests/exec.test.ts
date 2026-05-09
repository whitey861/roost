// Exec wrapper tests. We focus on the failure modes that have crashed the
// worker in production: a child that exits before stdin is fully written,
// a binary that doesn't exist, and a runaway that has to be killed by the
// timeout.

import { describe, it, expect } from 'vitest';
import { execCapture } from '../src/exec.js';

describe('execCapture: happy path', () => {
  it('captures stdout and stderr separately and returns exit 0', async () => {
    const res = await execCapture('bash', ['-c', 'echo hello; echo oops 1>&2; exit 0']);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('hello');
    expect(res.stderr).toContain('oops');
    expect(res.timedOut).toBe(false);
    expect(res.signal).toBeNull();
    expect(res.spawnError).toBeNull();
  });

  it('feeds stdin to the child and reads it back via cat', async () => {
    const res = await execCapture('cat', [], { stdin: 'one\ntwo\nthree\n' });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe('one\ntwo\nthree\n');
    expect(res.spawnError).toBeNull();
  });

  it('emits each non-empty stdout line through onLog', async () => {
    const lines: string[] = [];
    await execCapture('bash', ['-c', 'echo a; echo b; echo c'], { onLog: (l) => lines.push(l) });
    expect(lines).toEqual(['a', 'b', 'c']);
  });

  it('emits stderr lines tagged with [stderr]', async () => {
    const lines: string[] = [];
    await execCapture('bash', ['-c', 'echo boom 1>&2'], { onLog: (l) => lines.push(l) });
    expect(lines.some((l) => l.includes('[stderr] boom'))).toBe(true);
  });
});

describe('execCapture: failure modes that previously crashed the worker', () => {
  it('does not crash when the child closes stdin before we finish writing', async () => {
    // `head -n 0` closes stdin immediately. Without an `error` listener on
    // child.stdin, the EPIPE from our subsequent write would propagate as
    // an unhandled error event and tear down the parent.
    const huge = 'x'.repeat(2 * 1024 * 1024); // 2MB
    const res = await execCapture('bash', ['-c', 'head -n 0 > /dev/null'], { stdin: huge });
    // head exits 0; we just need to confirm the parent survived and we got
    // a structured result.
    expect(res.exitCode).toBe(0);
    expect(res.timedOut).toBe(false);
    // spawnError may or may not be set depending on timing of the EPIPE. If
    // it is set, it should be a stdin / EPIPE-style message, not a throw.
    if (res.spawnError) {
      expect(res.spawnError.toLowerCase()).toMatch(/stdin|epipe|broken/);
    }
  });

  it('returns a structured result when the binary does not exist', async () => {
    const res = await execCapture('this-binary-definitely-does-not-exist', []);
    expect(res.exitCode).toBe(-1);
    expect(res.spawnError).toBeTruthy();
    expect(res.spawnError ?? '').toMatch(/ENOENT|not found|spawn/i);
  });

  it('kills a runaway child via the timeout and reports it', async () => {
    const res = await execCapture('bash', ['-c', 'sleep 30'], { timeoutMs: 100 });
    expect(res.timedOut).toBe(true);
    // Killed by SIGKILL; exit code is -1 and signal is set.
    expect(res.signal).toBe('SIGKILL');
  });

  it('survives an early-exit child that ignores stdin', async () => {
    // `true` exits 0 immediately without reading stdin. The parent then
    // tries to write a stdin payload — that write may or may not race the
    // child's exit, but we must never crash.
    const res = await execCapture('true', [], { stdin: 'irrelevant payload\n' });
    expect(res.exitCode).toBe(0);
    expect(res.timedOut).toBe(false);
  });

  it('logger errors are swallowed and do not crash the wrapper', async () => {
    const res = await execCapture('bash', ['-c', 'echo a; echo b'], {
      onLog: () => {
        throw new Error('logger blew up');
      },
    });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('a');
  });
});
