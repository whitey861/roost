// runDevJob: clones the target repo, runs Claude Code headlessly, runs the
// reported test command, opens a PR, and returns a JobOutcome.
//
// Phase 5 contract: a task_spec starting with `__test__:` is a stub job. The
// worker sleeps for the indicated seconds (defaulting to 10), reports
// completed without doing any GitHub work, and returns a fake summary. This
// gives us an end-to-end smoke path before the Phase 6 toolchain is wired up.

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execCapture, type ExecResult } from './exec.js';
import {
  branchNameForJob,
  buildClaudePrompt,
  parseClaudeResultBlock,
  renderPrBody,
} from './prompt.js';
import type { ClaudeCodeResult, DevJob, JobOutcome } from './types.js';

export interface RunDevJobDeps {
  // Logger callback. Each line is appended to the worker_log column on the
  // dev_jobs row by the caller.
  log: (line: string) => void;
  // Used for the workdir prefix; tests can stub this.
  tmpRoot?: string;
  // Pluggable execCapture for tests.
  exec?: typeof execCapture;
  // Pluggable env vars for tests.
  env?: NodeJS.ProcessEnv;
}

const DEFAULT_TMP_ROOT = '/tmp';

export const STUB_PREFIX = '__test__:';

// Recognise the Phase 5 stub job spec. Returns the requested sleep duration
// in milliseconds, defaulting to 10 seconds.
export function isStubJob(taskSpec: string): { isStub: boolean; sleepMs: number } {
  if (!taskSpec.startsWith(STUB_PREFIX)) return { isStub: false, sleepMs: 0 };
  // "__test__: 10s sleep" -> 10000
  // "__test__: 2 second sleep" -> 2000
  const m = taskSpec.match(/(\d+)\s*s/);
  const seconds = m && m[1] ? Math.max(1, Math.min(120, Number.parseInt(m[1], 10))) : 10;
  return { isStub: true, sleepMs: seconds * 1000 };
}

export async function runDevJob(job: DevJob, deps: RunDevJobDeps): Promise<JobOutcome> {
  const stub = isStubJob(job.task_spec);
  if (stub.isStub) return runStubJob(job, stub.sleepMs, deps);
  return runRealJob(job, deps);
}

async function runStubJob(job: DevJob, sleepMs: number, deps: RunDevJobDeps): Promise<JobOutcome> {
  deps.log(`[stub] sleeping ${sleepMs}ms for job ${job.id}`);
  await new Promise((r) => setTimeout(r, sleepMs));
  deps.log(`[stub] done`);
  return {
    status: 'completed',
    agent_summary: 'Test job, no work done.',
    files_changed: 0,
    tests_passed: null,
    cost_usd: 0,
    iterations_used: 0,
  };
}

// Real Phase 6 path. Heavily isolated for testability via the deps object,
// but we don't unit-test the actual clone/push/PR end-to-end (that's the
// smoke test in the deployment doc); the unit tests cover the path that
// runs through synthesised exec results to confirm the wiring is right.
async function runRealJob(job: DevJob, deps: RunDevJobDeps): Promise<JobOutcome> {
  const exec = deps.exec ?? execCapture;
  const env = deps.env ?? process.env;
  const tmpRoot = deps.tmpRoot ?? DEFAULT_TMP_ROOT;

  const githubPat = env.GITHUB_PAT;
  if (!githubPat) {
    return {
      status: 'failed',
      error_message: 'GITHUB_PAT env var not configured on worker.',
      cost_usd: 0,
      iterations_used: 0,
    };
  }
  const anthropicKey = env.ANTHROPIC_API_KEY;
  if (!anthropicKey) {
    return {
      status: 'failed',
      error_message: 'ANTHROPIC_API_KEY env var not configured on worker.',
      cost_usd: 0,
      iterations_used: 0,
    };
  }

  const workDir = path.join(tmpRoot, `job-${job.id}`);
  const repoDir = path.join(workDir, 'repo');
  const branchName = branchNameForJob(job.id);
  const baseBranch = job.target_branch ?? 'main';
  const startMs = Date.now();

  try {
    await fs.mkdir(workDir, { recursive: true });

    // 1. Clone (with PAT inlined into the URL — never logged).
    deps.log(`[clone] ${job.target_repo} -> ${repoDir}`);
    const cloneUrl = `https://x-access-token:${githubPat}@github.com/${job.target_repo}.git`;
    const cloneRes = await exec('git', ['clone', cloneUrl, repoDir], {
      timeoutMs: 5 * 60 * 1000,
    });
    if (cloneRes.exitCode !== 0) {
      throw new Error(`git clone failed: ${trimErr(cloneRes)}`);
    }

    // Configure git identity for the dev agent's commits.
    await exec('git', ['config', 'user.email', 'roost-dev-agent@noreply.local'], { cwd: repoDir });
    await exec('git', ['config', 'user.name', 'Roost Dev Agent'], { cwd: repoDir });

    // 2. Branch.
    const checkoutRes = await exec('git', ['checkout', '-b', branchName, `origin/${baseBranch}`], {
      cwd: repoDir,
    });
    if (checkoutRes.exitCode !== 0) {
      // Try without origin/ prefix in case the base branch is local-only.
      const fallback = await exec('git', ['checkout', '-b', branchName], { cwd: repoDir });
      if (fallback.exitCode !== 0) {
        throw new Error(`branch creation failed: ${trimErr(fallback)}`);
      }
    }

    // 3. Drive Claude Code. The CLI reads the prompt from stdin in --print
    // mode; we still write PROMPT.md to disk for post-mortem inspection if
    // the job fails, but the live process gets the bytes over the pipe.
    const promptFile = path.join(workDir, 'PROMPT.md');
    const promptText = buildClaudePrompt(job);
    await fs.writeFile(promptFile, promptText, 'utf8');

    const runtimeMs = Math.max(60_000, (job.max_runtime_minutes ?? 120) * 60 * 1000);
    deps.log(`[claude] starting, timeout ${runtimeMs}ms`);


    const claudeRes = await exec('claude', ['--print', '--dangerously-skip-permissions'], {
      cwd: repoDir,
      env: {
        ...env,
      },
      timeoutMs: runtimeMs,
      onLog: (line) => deps.log(line),
      stdin: promptText,
    });

    if (claudeRes.timedOut) {
      throw new Error(`Claude Code timed out after ${runtimeMs}ms`);
    }

    // 4. Parse the result block.
    const parsed = parseClaudeResultBlock(claudeRes.stdout);
    const result: ClaudeCodeResult = parsed ?? {
      prTitle: 'Roost dev agent: incomplete result',
      prBody: 'Claude Code did not emit a parseable result block. Pushing whatever changes exist for human review.',
      commitMessage: 'Roost dev agent change',
      filesChanged: 0,
      summary: 'Claude Code did not emit a parseable result block.',
      testCommand: null,
      iterations: 0,
      cost_usd: 0,
    };

    // Budget cap check.
    const budgetCap = parseNumeric(job.max_cost_usd, 5.0);
    if (result.cost_usd > budgetCap) {
      throw new Error(`Budget exceeded: $${result.cost_usd.toFixed(4)} > $${budgetCap.toFixed(4)}`);
    }

    // 5. Run the suggested test command, if any.
    let testsPassed: boolean | null = null;
    let testsSummary: string | null = null;
    if (result.testCommand) {
      deps.log(`[tests] running: ${result.testCommand}`);
      const testRes = await exec('bash', ['-c', result.testCommand], {
        cwd: repoDir,
        timeoutMs: 10 * 60 * 1000,
        onLog: (line) => deps.log(line),
      });
      testsPassed = testRes.exitCode === 0;
      testsSummary = (testRes.stdout + (testRes.stderr ? `\n${testRes.stderr}` : '')).slice(-2000);
    }

    // 6. Stage, commit, push.
    await exec('git', ['add', '-A'], { cwd: repoDir });
    const statusRes = await exec('git', ['status', '--porcelain'], { cwd: repoDir });
    const hasChanges = statusRes.stdout.trim().length > 0;
    if (!hasChanges) {
      // Allow Claude to have committed itself; if so just push. Otherwise
      // fail loudly: an empty diff is rarely what the user wanted.
      const logRes = await exec('git', ['log', `${baseBranch}..HEAD`, '--oneline'], { cwd: repoDir });
      if (logRes.stdout.trim().length === 0) {
        throw new Error('No changes were made by the dev agent.');
      }
    } else {
      const commitRes = await exec('git', ['commit', '-m', result.commitMessage], { cwd: repoDir });
      if (commitRes.exitCode !== 0) {
        throw new Error(`git commit failed: ${trimErr(commitRes)}`);
      }
    }

    const pushRes = await exec('git', ['push', '-u', 'origin', branchName], { cwd: repoDir });
    if (pushRes.exitCode !== 0) {
      throw new Error(`git push failed: ${trimErr(pushRes)}`);
    }

    // 7. Open the PR via gh CLI. gh authenticates via GH_TOKEN.
    const prBody = renderPrBody(result.prBody, job.id);
    const prRes = await exec(
      'gh',
      ['pr', 'create', '--base', baseBranch, '--head', branchName, '--title', result.prTitle, '--body', prBody],
      {
        cwd: repoDir,
        env: { ...env, GH_TOKEN: githubPat },
        timeoutMs: 60 * 1000,
      },
    );
    if (prRes.exitCode !== 0) {
      throw new Error(`gh pr create failed: ${trimErr(prRes)}`);
    }
    const prUrl = prRes.stdout.trim().split('\n').filter((l) => l.startsWith('http'))[0] ?? prRes.stdout.trim();
    const prNumber = parsePrNumber(prUrl);

    return {
      status: 'completed',
      branch_name: branchName,
      pr_url: prUrl,
      pr_number: prNumber,
      files_changed: result.filesChanged,
      tests_passed: testsPassed,
      tests_summary: testsSummary,
      cost_usd: result.cost_usd,
      iterations_used: result.iterations,
      agent_summary: result.summary,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    deps.log(`[error] ${message}`);
    return {
      status: 'failed',
      branch_name: branchName,
      error_message: message,
      cost_usd: 0,
      iterations_used: 0,
    };
  } finally {
    try {
      await fs.rm(workDir, { recursive: true, force: true });
    } catch (cleanupErr) {
      deps.log(`[cleanup] failed to remove ${workDir}: ${String(cleanupErr)}`);
    }
    deps.log(`[done] ${Math.round((Date.now() - startMs) / 1000)}s elapsed`);
  }
}

function trimErr(res: ExecResult): string {
  return (res.stderr || res.stdout).trim().slice(-500);
}

export function parsePrNumber(url: string): number | null {
  const m = url.match(/\/pull\/(\d+)/);
  if (!m || !m[1]) return null;
  const n = Number.parseInt(m[1], 10);
  return Number.isFinite(n) ? n : null;
}

function parseNumeric(v: number | string | null, fallback: number): number {
  if (v === null || v === undefined) return fallback;
  if (typeof v === 'number') return v;
  const n = Number.parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
}
