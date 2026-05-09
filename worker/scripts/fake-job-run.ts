// Local smoke harness for the dev-agent worker. Runs runDevJob against a
// fake `exec` implementation that simulates the failure modes seen in
// production, plus a happy-path run, and asserts:
//   1. The parent process never exits because of a child-process event.
//   2. Logs emitted during the run are captured before any failure.
//   3. The promise from runDevJob always resolves with a structured outcome.
//
// Run it with:
//   npx tsx worker/scripts/fake-job-run.ts
//
// This deliberately avoids Supabase, GitHub, or a real claude install. It
// does NOT replace the unit tests; it's a one-shot sanity check we can run
// after touching exec.ts or main.ts.

import { runDevJob } from '../src/job-handler.js';
import { execCapture, type ExecResult } from '../src/exec.js';
import type { DevJob } from '../src/types.js';

function fakeJob(taskSpec: string, id = 'fake-job-001'): DevJob {
  return {
    id,
    workspace_id: 'ws',
    agent_id: 'agent',
    session_id: null,
    user_id: 'user',
    task_spec: taskSpec,
    target_repo: 'whitey861/roost-test',
    target_branch: 'main',
    agent_provider: 'claude_code',
    agent_provider_config: {},
    max_iterations: 50,
    max_cost_usd: 5,
    max_runtime_minutes: 1,
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
  };
}

const env = {
  GITHUB_PAT: 'fake-pat',
  ANTHROPIC_API_KEY: 'fake-key',
} as NodeJS.ProcessEnv;

interface Scenario {
  name: string;
  run: () => Promise<void>;
}

const scenarios: Scenario[] = [
  {
    name: 'stub job completes',
    run: async () => {
      const lines: string[] = [];
      const outcome = await runDevJob(fakeJob('__test__: 1s sleep'), {
        log: (l) => lines.push(l),
      });
      assertEqual(outcome.status, 'completed', 'stub status');
      assertTrue(lines.some((l) => l.includes('[stub]')), 'stub log emitted');
    },
  },
  {
    name: 'real path: claude crashes mid-run (simulated EPIPE)',
    run: async () => {
      const lines: string[] = [];
      let claudeCalled = false;
      const fakeExec = async (
        cmd: string,
        _args: string[],
        opts: { onLog?: (l: string) => void } = {},
      ): Promise<ExecResult> => {
        if (cmd === 'claude') {
          claudeCalled = true;
          // Mimic execCapture: stream lines through onLog as they arrive,
          // then resolve with the crashed result.
          opts.onLog?.('partial output before crash');
          opts.onLog?.('[stderr] EPIPE on write');
          return {
            exitCode: -1,
            stdout: 'partial output before crash\n',
            stderr: 'EPIPE on write\n',
            timedOut: false,
            signal: 'SIGSEGV',
            spawnError: 'stdin: write EPIPE',
          };
        }
        return ok();
      };
      const outcome = await runDevJob(fakeJob('do real work'), {
        log: (l) => lines.push(l),
        env,
        exec: fakeExec as never,
      });
      assertTrue(claudeCalled, 'claude was invoked');
      assertEqual(outcome.status, 'failed', 'crash -> failed outcome');
      assertTrue(
        (outcome.error_message ?? '').toLowerCase().includes('crash')
          || (outcome.error_message ?? '').toLowerCase().includes('epipe'),
        `error_message mentions the crash, got: ${outcome.error_message}`,
      );
      assertTrue(
        lines.some((l) => l.includes('partial output before crash')),
        'pre-crash claude output captured in logs',
      );
      assertTrue(
        lines.some((l) => l.includes('[claude] exited')),
        'exit-line summary emitted',
      );
    },
  },
  {
    name: 'real path: claude times out',
    run: async () => {
      const lines: string[] = [];
      const fakeExec = async (cmd: string, _args: string[]): Promise<ExecResult> => {
        if (cmd === 'claude') {
          return {
            exitCode: -1,
            stdout: '',
            stderr: '',
            timedOut: true,
            signal: 'SIGKILL',
            spawnError: null,
          };
        }
        return ok();
      };
      const outcome = await runDevJob(fakeJob('do real work'), {
        log: (l) => lines.push(l),
        env,
        exec: fakeExec as never,
      });
      assertEqual(outcome.status, 'failed', 'timeout -> failed outcome');
      assertTrue(
        (outcome.error_message ?? '').toLowerCase().includes('timed out'),
        `error_message mentions timeout, got: ${outcome.error_message}`,
      );
    },
  },
  {
    name: 'real path: missing GITHUB_PAT fails fast',
    run: async () => {
      const outcome = await runDevJob(fakeJob('do real work'), {
        log: () => {},
        env: {} as NodeJS.ProcessEnv,
      });
      assertEqual(outcome.status, 'failed', 'missing PAT -> failed');
      assertTrue(
        (outcome.error_message ?? '').includes('GITHUB_PAT'),
        'error_message mentions GITHUB_PAT',
      );
    },
  },
  {
    name: 'real execCapture: child closes stdin then exits, parent survives',
    run: async () => {
      // Drives the live execCapture (no fake) against a shell command that
      // closes stdin immediately and exits. With the old wrapper, EPIPE on
      // a 2MB write would propagate as an unhandled error event and tear
      // the worker down. Now it should resolve cleanly.
      const huge = 'x'.repeat(2 * 1024 * 1024);
      const res = await execCapture('bash', ['-c', 'head -n 0 > /dev/null; exit 0'], {
        stdin: huge,
        timeoutMs: 5000,
      });
      assertEqual(res.exitCode, 0, 'child exited 0');
      assertEqual(res.timedOut, false, 'did not time out');
      // We expect the worker process to still be running here. If we got
      // this far the parent did not die.
    },
  },
  {
    name: 'real execCapture: nonexistent binary returns spawnError',
    run: async () => {
      const res = await execCapture('/no/such/binary-xyz', []);
      assertEqual(res.exitCode, -1, 'exit code -1 on spawn failure');
      assertTrue(Boolean(res.spawnError), 'spawnError populated');
    },
  },
];

function ok(): ExecResult {
  return { exitCode: 0, stdout: '', stderr: '', timedOut: false, signal: null, spawnError: null };
}

function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

function assertTrue(cond: boolean, label: string): void {
  if (!cond) {
    throw new Error(`assertion failed: ${label}`);
  }
}

async function main(): Promise<void> {
  let passed = 0;
  let failed = 0;
  let unhandledFired = false;

  process.on('uncaughtException', (err: Error) => {
    unhandledFired = true;
    console.error(`[fake-job-run] uncaughtException: ${err.message}`);
  });
  process.on('unhandledRejection', (reason: unknown) => {
    unhandledFired = true;
    console.error(
      `[fake-job-run] unhandledRejection: ${reason instanceof Error ? reason.message : String(reason)}`,
    );
  });

  for (const sc of scenarios) {
    process.stdout.write(`- ${sc.name} ... `);
    try {
      await sc.run();
      console.log('ok');
      passed++;
    } catch (err) {
      console.log('FAIL');
      console.error(`  ${err instanceof Error ? err.message : String(err)}`);
      failed++;
    }
  }

  // Give any straggler 'error' events on streams a tick to fire.
  await new Promise((r) => setTimeout(r, 50));

  console.log(`\nresults: ${passed} passed, ${failed} failed`);
  if (unhandledFired) {
    console.error('FAIL: an unhandled error/rejection was raised during the run');
    process.exit(1);
  }
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error('[fake-job-run] top-level threw:', err);
  process.exit(1);
});
