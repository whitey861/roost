// Telegram delivery for dev_job_notifications.
//
// The dispatch loop polls for pending notifications and pushes a single
// Telegram message per notification. On success we mark `delivered=true`;
// on failure we increment delivery_attempts and stop after the retry cap.

import type { SupabaseClient } from '@supabase/supabase-js';
import { truncate } from './prompt.js';

const MAX_DELIVERY_ATTEMPTS = 5;
const TELEGRAM_MESSAGE_HARD_LIMIT = 4096;
// Reserve ~600 chars for the surrounding header + footer + URL.
const SUMMARY_LIMIT = 3500;

export interface NotificationRow {
  id: string;
  job_id: string;
  workspace_id: string;
  user_id: string;
  channel: 'telegram' | 'web';
  payload: Record<string, unknown>;
  delivered: boolean;
  delivery_attempts: number;
}

export interface NotificationPayload {
  status: 'completed' | 'failed' | 'timeout';
  pr_url?: string;
  error?: string;
  summary?: string;
  cost_usd?: number;
  runtime_seconds?: number;
}

// Insert a notification row. Called from runDevJob after writing the job
// outcome. The dispatch loop picks it up and delivers asynchronously.
export async function insertNotification(
  client: SupabaseClient,
  args: {
    jobId: string;
    workspaceId: string;
    userId: string;
    channel: 'telegram' | 'web';
    payload: NotificationPayload;
  },
): Promise<void> {
  const { error } = await client.from('dev_job_notifications').insert({
    job_id: args.jobId,
    workspace_id: args.workspaceId,
    user_id: args.userId,
    channel: args.channel,
    payload: args.payload,
    delivered: false,
    delivery_attempts: 0,
  });
  if (error) throw new Error(`insertNotification failed: ${error.message}`);
}

// Compose the Telegram message body. Pure: takes a payload and a job id,
// returns the string we POST to Telegram. Kept exported so tests can
// snapshot the rendering.
export function composeTelegramMessage(jobId: string, payload: NotificationPayload): string {
  const lines: string[] = [];
  lines.push(`Dev job ${shortJobId(jobId)} ${payload.status}.`);
  if (payload.pr_url) lines.push(`PR: ${payload.pr_url}`);
  if (payload.error) lines.push(`Error: ${truncate(payload.error, 500)}`);
  if (payload.summary) {
    lines.push('');
    lines.push(`Summary:`);
    lines.push(truncate(payload.summary, SUMMARY_LIMIT));
  }
  const footerBits: string[] = [];
  if (typeof payload.cost_usd === 'number') footerBits.push(`cost: $${payload.cost_usd.toFixed(4)}`);
  if (typeof payload.runtime_seconds === 'number') footerBits.push(`runtime: ${payload.runtime_seconds}s`);
  if (footerBits.length > 0) {
    lines.push('');
    lines.push(footerBits.join(', '));
  }
  return truncate(lines.join('\n'), TELEGRAM_MESSAGE_HARD_LIMIT);
}

function shortJobId(jobId: string): string {
  return jobId.replace(/-/g, '').slice(0, 8);
}

// Look up the user's Telegram chat id. Returns null if the user has not
// paired Telegram (they'll just miss the notification rather than the worker
// crashing).
async function chatIdForUser(client: SupabaseClient, userId: string): Promise<number | null> {
  const { data, error } = await client
    .from('telegram_links')
    .select('telegram_chat_id')
    .eq('user_id', userId)
    .eq('active', true)
    .maybeSingle();
  if (error) throw new Error(`telegram_links lookup failed: ${error.message}`);
  if (!data) return null;
  const cid = (data as { telegram_chat_id: number | null }).telegram_chat_id;
  return cid ?? null;
}

// Send a single message via Telegram's HTTP API. We don't pull in a heavy
// SDK: it's a JSON POST. Returns true on 2xx.
export async function sendTelegramMessage(
  botToken: string,
  chatId: number,
  text: string,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: false }),
  });
  return res.status >= 200 && res.status < 300;
}

// One pass of the dispatcher: read pending notifications and try to deliver
// each. Returns the number of delivered + the number of permanent failures.
export async function dispatchNotifications(
  client: SupabaseClient,
  opts: { telegramBotToken: string; fetchImpl?: typeof fetch; nowIso?: string },
): Promise<{ delivered: number; givenUp: number; pending: number }> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const nowIso = opts.nowIso ?? new Date().toISOString();
  const { data, error } = await client
    .from('dev_job_notifications')
    .select('id, job_id, workspace_id, user_id, channel, payload, delivered, delivery_attempts')
    .eq('delivered', false)
    .order('created_at', { ascending: true })
    .limit(50);
  if (error) throw new Error(`notification scan failed: ${error.message}`);
  const pending = (data ?? []) as NotificationRow[];

  let delivered = 0;
  let givenUp = 0;

  for (const row of pending) {
    if (row.delivery_attempts >= MAX_DELIVERY_ATTEMPTS) {
      // Mark as delivered=true with a delivered_at=null to take it out of
      // the polling set. We stop trying after the cap.
      const { error: uErr } = await client
        .from('dev_job_notifications')
        .update({ delivered: true, delivered_at: nowIso })
        .eq('id', row.id);
      if (uErr) throw new Error(`give-up mark failed: ${uErr.message}`);
      givenUp += 1;
      continue;
    }

    if (row.channel !== 'telegram') {
      // Web channel is a no-op for now; the frontend reads dev_jobs directly.
      const { error: uErr } = await client
        .from('dev_job_notifications')
        .update({ delivered: true, delivered_at: nowIso })
        .eq('id', row.id);
      if (uErr) throw new Error(`web-mark failed: ${uErr.message}`);
      delivered += 1;
      continue;
    }

    const chatId = await chatIdForUser(client, row.user_id);
    if (chatId === null) {
      // No paired Telegram account: increment attempts and move on. A
      // user might pair later, but keep the row pending until we cap out.
      const { error: uErr } = await client
        .from('dev_job_notifications')
        .update({ delivery_attempts: row.delivery_attempts + 1 })
        .eq('id', row.id);
      if (uErr) throw new Error(`no-chat-id update failed: ${uErr.message}`);
      continue;
    }

    const payload = row.payload as unknown as NotificationPayload;
    const text = composeTelegramMessage(row.job_id, payload);
    let ok = false;
    try {
      ok = await sendTelegramMessage(opts.telegramBotToken, chatId, text, fetchImpl);
    } catch {
      ok = false;
    }
    if (ok) {
      const { error: uErr } = await client
        .from('dev_job_notifications')
        .update({ delivered: true, delivered_at: nowIso, delivery_attempts: row.delivery_attempts + 1 })
        .eq('id', row.id);
      if (uErr) throw new Error(`delivery mark failed: ${uErr.message}`);
      delivered += 1;
    } else {
      const { error: uErr } = await client
        .from('dev_job_notifications')
        .update({ delivery_attempts: row.delivery_attempts + 1 })
        .eq('id', row.id);
      if (uErr) throw new Error(`delivery-fail update failed: ${uErr.message}`);
    }
  }

  return { delivered, givenUp, pending: pending.length };
}
