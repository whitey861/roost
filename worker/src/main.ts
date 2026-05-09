// Roost dev-agent worker entry point.
//
// Lifecycle:
//   1. Boot. Install crash-shield handlers, recover any leases left stranded
//      by previous crashes.
//   2. Loop forever:
//        a. Try to lease one queued job.
//        b. If we got one, fork a heartbeat keepalive and run it. While it
//           runs, periodically flush the in-memory log buffer to the
//           dev_jobs.worker_log column so a crash leaves us with a usable
//           post-mortem.
//        c. Whether or not we got a job, run one notification dispatch pass.
//        d. Sleep for POLL_INTERVAL_MS.

import { randomUUID } from 'node:crypto';
import { writeSync } from 'node:fs';
import { hostname } from 'node:os';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { requireEnv, envInt } from './env.js';
import {
  HEARTBEAT_INTERVAL_MS,
  extendLease,
  recoverExpiredLeases,
  tryLeaseJob,
} from './lease.js';
import { runDevJob } from './job-handler.js';
import { dispatchNotifications, insertNotification } from './notify.js';
import type { DevJob, JobOutcome } from './types.js';

const POLL_INTERVAL_MS = 10 * 1000;
// How often to push the in-memory log buffer to dev_jobs.worker_log while
// a job is running. Trades a small amount of write traffic for the ability
// to see what the agent was doing right before any crash.
const LOG_FLUSH_INTERVAL_MS = 2000;
const LOG_BUF_MAX_BYTES = 64 * 1024;

// Synchronous log helper. Bypasses Node's async stdout buffering so a line
// is on disk before we hand control back to anything that might exit. Use
// this in crash/exit paths where console.log lines have been observed to
// vanish (the worker's "exit code 128 with no preceding logs" pattern).
function syncLog(line: string): void {
  try {
    writeSync(1, `${line}\n`);
  } catch {
    // stdout itself is broken — nothing useful left to do.
  }
}

function syncErr(line: string): void {
  try {
    writeSync(2, `${line}\n`);
  } catch {
    // stderr is broken — fall through.
  }
}

// Force stdout/stderr into blocking mode. By default Node writes to a pipe
// (which is what App Platform gives us) asynchronously, so an abrupt exit
// drops any in-flight writes. Setting the handles to blocking makes
// console.log behave the way operators expect in a container.
function setStdioBlocking(): void {
  for (const stream of [process.stdout, process.stderr] as const) {
    const handle = (stream as unknown as { _handle?: { setBlocking?: (b: boolean) => void } })._handle;
    handle?.setBlocking?.(true);
  }
}

// Install a single set of last-resort handlers for the worker process. These
// fire in cases like an unhandled rejection from a fire-and-forget promise
// or an EPIPE on a child process pipe with no listener attached (we attach
// them in exec.ts now, but the safety net belongs here too). The intent is
// that the worker should NEVER exit because of a child-process event.
let crashShieldsInstalled = false;
function installCrashShields(): void {
  if (crashShieldsInstalled) return;
  crashShieldsInstalled = true;
  setStdioBlocking();
  process.on('uncaughtException', (err: Error) => {
    syncErr(`[worker] uncaughtException: ${err.message}\n${err.stack ?? ''}`);
  });
  process.on('unhandledRejection', (reason: unknown) => {
    const msg = reason instanceof Error ? `${reason.message}\n${reason.stack ?? ''}` : String(reason);
    syncErr(`[worker] unhandledRejection: ${msg}`);
  });
  // SIGPIPE shouldn't kill us either. Node masks SIGPIPE by default for
  // most stdio configurations, but we make it explicit.
  process.on('SIGPIPE', () => {
    syncErr('[worker] received SIGPIPE, ignoring');
  });
  // EPIPE on the parent's own stdout/stderr (e.g. App Platform closing the
  // log pipe) would otherwise propagate as an uncaughtException and kill
  // the worker. Swallow it.
  for (const [name, stream] of [['stdout', process.stdout], ['stderr', process.stderr]] as const) {
    stream.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EPIPE') return;
      syncErr(`[worker] ${name} error: ${err.message}`);
    });
  }
  // Capture exit cause so a silent death leaves a footprint in the log.
  // 'exit' fires synchronously from inside Node's exit path.
  process.on('exit', (code) => {
    syncErr(`[worker] process exit code=${code}`);
  });
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGQUIT'] as const) {
    process.on(sig, () => {
      syncErr(`[worker] received ${sig}, exiting`);
      process.exit(0);
    });
  }
}

// DigitalOcean App Platform substitutes a small set of bindable variables
// like ${APP_DOMAIN} at deploy time. If someone wires an env var to a
// non-bindable token (e.g. WORKER_INSTANCE_ID=${APP_INSTANCE_ID}), the
// literal text passes through and ends up in our logs. Detect that and
// substitute something useful so operators can tell instances apart.
export function resolveWorkerId(raw: string | undefined): string {
  if (!raw || raw === '') return `worker-${hostname()}-${randomUUID().slice(0, 8)}`;
  if (/^\$\{[^}]+\}$/.test(raw)) {
    return `worker-${hostname()}-${randomUUID().slice(0, 8)}`;
  }
  return raw;
}

async function processOneJob(
  client: SupabaseClient,
  workerId: string,
  job: DevJob,
): Promise<void> {
  const startTs = Date.now();
  const logBuf: string[] = [];

  // Snapshot the latest buffer to dev_jobs.worker_log. We coalesce concurrent
  // calls so a flush in flight doesn't race with the next one.
  let flushing = false;
  let flushAgain = false;
  const flushLog = async (): Promise<void> => {
    if (flushing) {
      flushAgain = true;
      return;
    }
    flushing = true;
    try {
      do {
        flushAgain = false;
        const snapshot = logBuf.join('\n').slice(-LOG_BUF_MAX_BYTES);
        const { error } = await client
          .from('dev_jobs')
          .update({
            worker_log: snapshot,
            updated_at: new Date().toISOString(),
          })
          .eq('id', job.id);
        if (error) {
          console.error(
            `[worker] flushLog(${job.id}) failed: ${error.message}`,
          );
        }
      } while (flushAgain);
    } catch (err) {
      console.error(
        `[worker] flushLog(${job.id}) threw: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      flushing = false;
    }
  };

  const log = (line: string): void => {
    const stamped = `[${new Date().toISOString()}] ${line}`;
    console.log(stamped);
    logBuf.push(stamped);
    // Cap in-memory buffer so very long runs don't OOM.
    if (logBuf.join('\n').length > LOG_BUF_MAX_BYTES) {
      logBuf.splice(0, Math.max(1, Math.floor(logBuf.length / 4)));
    }
  };

  log(`leased job ${job.id} (${job.target_repo})`);

  // Periodic flush so a crash mid-job leaves us with the most recent N lines
  // already persisted in dev_jobs.worker_log.
  const flushTimer = setInterval(() => {
    void flushLog();
  }, LOG_FLUSH_INTERVAL_MS);
  // Don't keep the event loop alive for this timer — we'll clear it
  // ourselves in the finally block.
  flushTimer.unref?.();

  let stopHeartbeat = false;
  const heartbeat = (async () => {
    while (!stopHeartbeat) {
      await sleep(HEARTBEAT_INTERVAL_MS);
      if (stopHeartbeat) break;
      try {
        const ok = await extendLease(client, job.id, workerId);
        if (!ok) log(`[heartbeat] lost lease on ${job.id}`);
      } catch (err) {
        log(`[heartbeat] error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  })();

  let outcome: JobOutcome;
  try {
    outcome = await runDevJob(job, { log });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`[fatal] runDevJob threw: ${message}`);
    outcome = {
      status: 'failed',
      error_message: message,
    };
  } finally {
    stopHeartbeat = true;
    clearInterval(flushTimer);
  }
  await heartbeat.catch(() => {});

  // Final flush of whatever is still buffered before we write the result.
  // The result update below also includes worker_log, but doing one more
  // flush here ensures any log-side errors during the result update don't
  // lose lines.
  await flushLog();

  const runtimeSeconds = Math.round((Date.now() - startTs) / 1000);
  const completedAt = new Date().toISOString();
  const update: Record<string, unknown> = {
    status: outcome.status,
    runtime_seconds: runtimeSeconds,
    updated_at: completedAt,
    completed_at: completedAt,
    worker_log: logBuf.join('\n').slice(-LOG_BUF_MAX_BYTES),
  };
  if (outcome.branch_name !== undefined) update.branch_name = outcome.branch_name;
  if (outcome.pr_url !== undefined) update.pr_url = outcome.pr_url;
  if (outcome.pr_number !== undefined) update.pr_number = outcome.pr_number;
  if (outcome.files_changed !== undefined) update.files_changed = outcome.files_changed;
  if (outcome.tests_passed !== undefined) update.tests_passed = outcome.tests_passed;
  if (outcome.tests_summary !== undefined) update.tests_summary = outcome.tests_summary;
  if (outcome.cost_usd !== undefined) update.cost_usd = outcome.cost_usd;
  if (outcome.iterations_used !== undefined) update.iterations_used = outcome.iterations_used;
  if (outcome.agent_summary !== undefined) update.agent_summary = outcome.agent_summary;
  if (outcome.error_message !== undefined) update.error_message = outcome.error_message;

  const { error: jErr } = await client.from('dev_jobs').update(update).eq('id', job.id);
  if (jErr) {
    console.error(`[worker] failed to write job result for ${job.id}: ${jErr.message}`);
    return;
  }

  // Queue a Telegram notification.
  try {
    await insertNotification(client, {
      jobId: job.id,
      workspaceId: job.workspace_id,
      userId: job.user_id,
      channel: 'telegram',
      payload: {
        status: outcome.status,
        pr_url: outcome.pr_url ?? undefined,
        error: outcome.error_message ?? undefined,
        summary: outcome.agent_summary ?? undefined,
        cost_usd: typeof outcome.cost_usd === 'number' ? outcome.cost_usd : undefined,
        runtime_seconds: runtimeSeconds,
      },
    });
  } catch (err) {
    console.error(`[worker] insertNotification failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function workerMain(): Promise<void> {
  installCrashShields();

  const supabaseUrl = requireEnv('SUPABASE_URL');
  const serviceKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
  const telegramToken = requireEnv('TELEGRAM_BOT_TOKEN');
  const workerId = resolveWorkerId(process.env.WORKER_INSTANCE_ID);
  const pollMs = envInt('WORKER_POLL_INTERVAL_MS', POLL_INTERVAL_MS);

  const client = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  syncLog(`[worker] booted, instance=${workerId}, pid=${process.pid}`);

  // Recover stranded leases at boot.
  try {
    const recovered = await recoverExpiredLeases(client);
    if (recovered.length > 0) syncLog(`[worker] recovered ${recovered.length} stranded jobs: ${recovered.join(', ')}`);
  } catch (err) {
    syncErr(`[worker] boot recovery failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Run forever.
  for (;;) {
    try {
      const recovered = await recoverExpiredLeases(client);
      if (recovered.length > 0) console.log(`[worker] requeued ${recovered.length} stuck jobs`);

      const job = await tryLeaseJob(client, workerId);
      if (job) {
        await processOneJob(client, workerId, job);
      }

      const dispatched = await dispatchNotifications(client, { telegramBotToken: telegramToken });
      if (dispatched.delivered > 0 || dispatched.givenUp > 0) {
        console.log(
          `[notify] delivered=${dispatched.delivered} givenUp=${dispatched.givenUp} pending=${dispatched.pending}`,
        );
      }
    } catch (err) {
      console.error(`[worker] loop error: ${err instanceof Error ? err.message : String(err)}`);
    }

    await sleep(pollMs);
  }
}

// Run main only when invoked as a CLI. Importing this file from tests must
// not trigger the live worker loop.
import { fileURLToPath } from 'node:url';

const isCli = (() => {
  try {
    return process.argv[1] === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (isCli) {
  // Install shields before workerMain so even fatal boot errors are
  // captured rather than silently exiting with a non-zero code.
  installCrashShields();
  workerMain().catch((err) => {
    const msg = err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err);
    syncErr(`[worker] fatal: ${msg}`);
    process.exit(1);
  });
}

export { installCrashShields };
