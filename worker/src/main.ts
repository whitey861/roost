// Roost dev-agent worker entry point.
//
// Lifecycle:
//   1. Boot. Recover any leases left stranded by previous crashes.
//   2. Loop forever:
//        a. Try to lease one queued job.
//        b. If we got one, fork a heartbeat keepalive and run it.
//        c. Whether or not we got a job, run one notification dispatch pass.
//        d. Sleep for POLL_INTERVAL_MS.

import { randomUUID } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { requireEnv, optionalEnv, envInt } from './env.js';
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

async function processOneJob(
  client: SupabaseClient,
  workerId: string,
  job: DevJob,
): Promise<void> {
  const startTs = Date.now();
  const logBuf: string[] = [];
  const log = (line: string): void => {
    const stamped = `[${new Date().toISOString()}] ${line}`;
    console.log(stamped);
    logBuf.push(stamped);
    // Cap in-memory log buffer at ~64KB so we don't OOM on very long runs.
    if (logBuf.join('\n').length > 64 * 1024) logBuf.splice(0, Math.max(1, Math.floor(logBuf.length / 4)));
  };

  log(`leased job ${job.id} (${job.target_repo})`);

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
    outcome = {
      status: 'failed',
      error_message: err instanceof Error ? err.message : String(err),
    };
  } finally {
    stopHeartbeat = true;
  }
  await heartbeat.catch(() => {});

  const runtimeSeconds = Math.round((Date.now() - startTs) / 1000);
  const completedAt = new Date().toISOString();
  const update: Record<string, unknown> = {
    status: outcome.status,
    runtime_seconds: runtimeSeconds,
    updated_at: completedAt,
    completed_at: completedAt,
    worker_log: logBuf.join('\n').slice(-64 * 1024),
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
  const supabaseUrl = requireEnv('SUPABASE_URL');
  const serviceKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
  const telegramToken = requireEnv('TELEGRAM_BOT_TOKEN');
  const workerId = optionalEnv('WORKER_INSTANCE_ID', `worker-${randomUUID()}`);
  const pollMs = envInt('WORKER_POLL_INTERVAL_MS', POLL_INTERVAL_MS);

  const client = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  console.log(`[worker] booted, instance=${workerId}`);

  // Recover stranded leases at boot.
  try {
    const recovered = await recoverExpiredLeases(client);
    if (recovered.length > 0) console.log(`[worker] recovered ${recovered.length} stranded jobs: ${recovered.join(', ')}`);
  } catch (err) {
    console.error(`[worker] boot recovery failed: ${err instanceof Error ? err.message : String(err)}`);
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
  workerMain().catch((err) => {
    console.error('[worker] fatal:', err);
    process.exit(1);
  });
}
