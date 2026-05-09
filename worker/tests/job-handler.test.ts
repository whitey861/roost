import { describe, it, expect } from 'vitest';
import { isStubJob, runDevJob } from '../src/job-handler.js';
import type { DevJob } from '../src/types.js';

function fakeJob(overrides: Partial<DevJob> = {}): DevJob {
  return {
    id: 'job-1',
    workspace_id: 'ws',
    agent_id: 'agent',
    session_id: null,
    user_id: 'user',
    task_spec: '__test__: 1s sleep',
    target_repo: 'whitey861/roost-test',
    target_branch: 'main',
    agent_provider: 'claude_code',
    agent_provider_config: {},
    max_iterations: 50,
    max_cost_usd: 5,
    max_runtime_minutes: 120,
    status: 'queued',
    leased_by: null,
    leased_at: null,
    lease_expires_at: null,
    branch_name: null,
    pr_url: null,
    pr_number: null,
    files_changed: null,
    tests_passed: null,
    tests_summary: null,
    cost_usd: null,
    iterations_used: null,
    runtime_seconds: null,
    agent_summary: null,
    worker_log: null,
    error_message: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    completed_at: null,
    ...overrides,
  };
}

describe('isStubJob', () => {
  it('detects __test__: prefix and pulls out a sleep duration', () => {
    expect(isStubJob('__test__: 5s sleep')).toEqual({ isStub: true, sleepMs: 5000 });
    expect(isStubJob('__test__: nothing here')).toEqual({ isStub: true, sleepMs: 10000 });
    expect(isStubJob('build a thing')).toEqual({ isStub: false, sleepMs: 0 });
  });

  it('clamps the requested sleep to a sensible upper bound', () => {
    const r = isStubJob('__test__: 99999s sleep');
    expect(r.sleepMs).toBeLessThanOrEqual(120_000);
  });
});

describe('runDevJob: stub path', () => {
  it('completes a stub job without touching git or claude', async () => {
    const lines: string[] = [];
    const outcome = await runDevJob(fakeJob({ task_spec: '__test__: 1s sleep' }), {
      log: (l) => lines.push(l),
    });
    expect(outcome.status).toBe('completed');
    expect(outcome.agent_summary).toBe('Test job, no work done.');
    expect(outcome.files_changed).toBe(0);
    expect(lines.some((l) => l.includes('[stub]'))).toBe(true);
  });
});

describe('runDevJob: real path with a mocked exec', () => {
  it('fails fast when GITHUB_PAT is not set', async () => {
    const outcome = await runDevJob(fakeJob({ task_spec: 'do real work' }), {
      log: () => {},
      env: {} as NodeJS.ProcessEnv,
    });
    expect(outcome.status).toBe('failed');
    expect(outcome.error_message).toMatch(/GITHUB_PAT/);
  });

  it('fails fast when ANTHROPIC_API_KEY is not set', async () => {
    const outcome = await runDevJob(fakeJob({ task_spec: 'do real work' }), {
      log: () => {},
      env: { GITHUB_PAT: 'x' } as NodeJS.ProcessEnv,
    });
    expect(outcome.status).toBe('failed');
    expect(outcome.error_message).toMatch(/ANTHROPIC_API_KEY/);
  });

  it('returns a failed outcome with branch_name when an exec command errors', async () => {
    // Synthesise an exec implementation that fails at clone. We assert the
    // failure path captures branch_name and an error_message — these are
    // the values the worker writes back to the dev_jobs row.
    const failingExec = async (cmd: string) => {
      if (cmd === 'git') return { exitCode: 1, stdout: '', stderr: 'fatal: not found', timedOut: false };
      return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
    };
    const outcome = await runDevJob(fakeJob({ task_spec: 'do real work' }), {
      log: () => {},
      env: { GITHUB_PAT: 'pat', ANTHROPIC_API_KEY: 'key' } as NodeJS.ProcessEnv,
      tmpRoot: '/tmp',
      exec: failingExec as never,
    });
    expect(outcome.status).toBe('failed');
    expect(outcome.branch_name).toMatch(/^roost-job-/);
    expect(outcome.error_message).toMatch(/git clone failed/);
  });
});
