// Roost: register the Telegram webhook with the Bot API.
// Usage: pnpm set-webhook
// Reads TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET, and PUBLIC_BASE_URL.

import { config as loadEnv } from 'dotenv';

loadEnv();

function requireEnv(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`Missing env var: ${key}`);
  return v;
}

async function main(): Promise<void> {
  const token = requireEnv('TELEGRAM_BOT_TOKEN');
  const secret = requireEnv('TELEGRAM_WEBHOOK_SECRET');
  const base = requireEnv('PUBLIC_BASE_URL').replace(/\/$/, '');
  const webhookUrl = `${base}/functions/v1/telegram-webhook`;

  const res = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url: webhookUrl,
      secret_token: secret,
      drop_pending_updates: true,
    }),
  });
  const body = await res.json();
  if (!body.ok) {
    console.error('setWebhook failed:', body);
    process.exit(1);
  }
  console.log(`Webhook registered: ${webhookUrl}`);
  console.log(body);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
