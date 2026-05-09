import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  composeTelegramMessage,
  dispatchNotifications,
  insertNotification,
  type NotificationPayload,
} from '../src/notify.js';
import { FakeDb, FakeSupabaseClient } from './fake-supabase.js';

function client(db: FakeDb): SupabaseClient {
  return new FakeSupabaseClient(db) as unknown as SupabaseClient;
}

function seedTelegramLink(db: FakeDb, userId: string, chatId: number): void {
  if (!db.tableRows('telegram_links').length) db.seedTable('telegram_links', []);
  db.tableRows('telegram_links').push({
    id: `tl-${userId}`,
    user_id: userId,
    telegram_user_id: 1234,
    telegram_chat_id: chatId,
    active: true,
  });
}

describe('composeTelegramMessage', () => {
  it('renders status, PR url, summary, cost, and runtime', () => {
    const payload: NotificationPayload = {
      status: 'completed',
      pr_url: 'https://github.com/foo/bar/pull/3',
      summary: 'Built it.',
      cost_usd: 0.42,
      runtime_seconds: 90,
    };
    const text = composeTelegramMessage('8a3f0b21-0000-0000-0000-000000000000', payload);
    expect(text).toContain('Dev job 8a3f0b21 completed.');
    expect(text).toContain('PR: https://github.com/foo/bar/pull/3');
    expect(text).toContain('Built it.');
    expect(text).toContain('cost: $0.4200');
    expect(text).toContain('runtime: 90s');
  });

  it('renders failed status without a PR link', () => {
    const text = composeTelegramMessage('id', {
      status: 'failed',
      error: 'Something broke.',
    });
    expect(text).toContain('failed');
    expect(text).toContain('Error: Something broke.');
    expect(text).not.toContain('PR:');
  });
});

describe('insertNotification', () => {
  it('inserts a pending row in dev_job_notifications', async () => {
    const db = new FakeDb();
    db.seedTable('dev_job_notifications', []);
    await insertNotification(client(db), {
      jobId: 'job-1',
      workspaceId: 'ws-1',
      userId: 'user-1',
      channel: 'telegram',
      payload: { status: 'completed', pr_url: 'https://x' },
    });
    const rows = db.tableRows('dev_job_notifications');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.delivered).toBe(false);
    expect(rows[0]?.delivery_attempts).toBe(0);
    expect((rows[0]?.payload as Record<string, unknown>).pr_url).toBe('https://x');
  });
});

describe('dispatchNotifications', () => {
  it('delivers a pending telegram notification when a chat id exists', async () => {
    const db = new FakeDb();
    db.seedTable('dev_job_notifications', []);
    seedTelegramLink(db, 'user-1', 4242);
    db.tableRows('dev_job_notifications').push({
      id: 'n-1',
      job_id: 'job-1',
      workspace_id: 'ws-1',
      user_id: 'user-1',
      channel: 'telegram',
      payload: { status: 'completed', pr_url: 'https://x', summary: 's' },
      delivered: false,
      delivery_attempts: 0,
      created_at: new Date().toISOString(),
    });

    let called = 0;
    let lastBody: Record<string, unknown> | null = null;
    const fetchImpl: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      called += 1;
      lastBody = init?.body ? JSON.parse(String(init.body)) : null;
      return new Response('{}', { status: 200 }) as unknown as Response;
    }) as typeof fetch;

    const res = await dispatchNotifications(client(db), {
      telegramBotToken: 'TOK',
      fetchImpl,
    });
    expect(called).toBe(1);
    expect(lastBody?.chat_id).toBe(4242);
    expect(res.delivered).toBe(1);
    const row = db.tableRows('dev_job_notifications')[0]!;
    expect(row.delivered).toBe(true);
    expect(row.delivered_at).toBeTruthy();
  });

  it('increments delivery_attempts when telegram returns a non-2xx', async () => {
    const db = new FakeDb();
    db.seedTable('dev_job_notifications', []);
    seedTelegramLink(db, 'user-1', 1);
    db.tableRows('dev_job_notifications').push({
      id: 'n-2',
      job_id: 'j',
      workspace_id: 'ws',
      user_id: 'user-1',
      channel: 'telegram',
      payload: { status: 'failed' },
      delivered: false,
      delivery_attempts: 1,
      created_at: new Date().toISOString(),
    });
    const fetchImpl: typeof fetch = (async () => new Response('nope', { status: 500 })) as typeof fetch;
    const res = await dispatchNotifications(client(db), { telegramBotToken: 'T', fetchImpl });
    expect(res.delivered).toBe(0);
    const row = db.tableRows('dev_job_notifications')[0]!;
    expect(row.delivered).toBe(false);
    expect(row.delivery_attempts).toBe(2);
  });

  it('gives up after the cap and marks delivered to take it off the queue', async () => {
    const db = new FakeDb();
    db.seedTable('dev_job_notifications', []);
    db.tableRows('dev_job_notifications').push({
      id: 'n-3',
      job_id: 'j',
      workspace_id: 'ws',
      user_id: 'user-x',
      channel: 'telegram',
      payload: { status: 'failed' },
      delivered: false,
      delivery_attempts: 5,
      created_at: new Date().toISOString(),
    });
    const fetchImpl: typeof fetch = (async () => new Response('{}', { status: 200 })) as typeof fetch;
    const res = await dispatchNotifications(client(db), { telegramBotToken: 'T', fetchImpl });
    expect(res.givenUp).toBe(1);
    const row = db.tableRows('dev_job_notifications')[0]!;
    expect(row.delivered).toBe(true);
  });
});
