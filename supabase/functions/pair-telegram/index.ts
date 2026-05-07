// Roost: POST /pair-telegram
// Authenticated endpoint that generates a 6-digit pairing code with a
// 10-minute expiry and returns the bot username so the frontend can show
// "Send /start <code> to @bot".

import { requireAuth } from '../_shared/auth.ts';
import { serviceRoleClient } from '../_shared/supabase.ts';
import { jsonError, jsonOk, corsHeaders, HttpError } from '../_shared/errors.ts';
import { envOptional } from '../_shared/env.ts';
import { getMe } from '../_shared/telegram.ts';

const TEN_MINUTES_MS = 10 * 60 * 1000;

function sixDigitCode(): string {
  const buf = new Uint8Array(4);
  crypto.getRandomValues(buf);
  // Map to a 6-digit number with leading zeros.
  const n = ((buf[0]! << 24) | (buf[1]! << 16) | (buf[2]! << 8) | buf[3]!) >>> 0;
  return String(n % 1_000_000).padStart(6, '0');
}

async function resolveBotUsername(): Promise<string> {
  const cached = envOptional('TELEGRAM_BOT_USERNAME');
  if (cached) return cached;
  try {
    const me = await getMe();
    return me.username;
  } catch {
    return 'unknown_bot';
  }
}

async function handle(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }
  if (req.method !== 'POST') return jsonError(405, 'method_not_allowed', 'Use POST.');

  let auth;
  try {
    auth = await requireAuth(req);
  } catch (err) {
    if (err instanceof HttpError) return jsonError(err.status, err.code, err.message);
    return jsonError(401, 'unauthorized', 'Authentication failed.');
  }

  const code = sixDigitCode();
  const expiresAt = new Date(Date.now() + TEN_MINUTES_MS).toISOString();

  const service = serviceRoleClient();
  const { error } = await service
    .from('telegram_pairing_codes')
    .insert({ user_id: auth.userId, code, expires_at: expiresAt });
  if (error) return jsonError(500, 'db_error', error.message);

  const botUsername = await resolveBotUsername();
  return jsonOk({ code, expires_at: expiresAt, bot_username: botUsername });
}

// deno-lint-ignore no-explicit-any
(globalThis as any).Deno?.serve(handle);
