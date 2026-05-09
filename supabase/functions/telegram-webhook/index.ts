// Roost: POST /telegram-webhook
// Receives Telegram updates, routes text messages through the shared chat
// runtime, and handles slash commands and approval inline keyboard callbacks.
//
// Auth: requires X-Telegram-Bot-Api-Secret-Token to match TELEGRAM_WEBHOOK_SECRET.

import { serviceRoleClient } from '../_shared/supabase.ts';
import { env, envOptional } from '../_shared/env.ts';
import { jsonError, jsonOk } from '../_shared/errors.ts';
import { defaultAnthropicClient } from '../_shared/anthropic.ts';
import { runChatCollecting } from '../_shared/chat-runtime.ts';
import { answerCallbackQuery, editMessageText, sendMessage, type InlineKeyboardMarkup } from '../_shared/telegram.ts';

// Telegram update types we care about in this phase.
interface TelegramUser {
  id: number;
  username?: string;
  first_name?: string;
  is_bot?: boolean;
}

interface TelegramChat {
  id: number;
  type: 'private' | 'group' | 'supergroup' | 'channel';
}

interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  date: number;
  text?: string;
}

interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  message?: TelegramMessage;
  data?: string;
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

const NOT_LINKED_REPLY = "This bot isn't linked to a Roost account. Visit your Roost settings to get a pairing code, then send `/start <code>` here.";
const HELP_TEXT = [
  'Roost commands:',
  '/use <slug> - switch the active workspace',
  '/where - show the active workspace',
  '/reset - start a fresh chat session',
  '/spawn <owner/repo> [<minutes>] [<cost>] - dev workspace only: queue all user messages in this thread as a dev job, bypassing the agent',
  '/help - show this help',
].join('\n');

// Inline mirror of shared/telegram-helpers.ts#parseSpawnArgs. Kept in sync
// with that module (which is unit-tested) because Deno and Node imports
// don't share a single source of truth for these helpers.
function parseSpawnArgsInline(arg: string | null): { repo: string; maxRuntimeMinutes: number; maxCostUsd: number } | { error: string } {
  const usage = 'Usage: /spawn <owner/repo> [<minutes>] [<cost_usd>]';
  if (!arg || arg.trim().length === 0) return { error: usage };
  const parts = arg.trim().split(/\s+/);
  if (parts.length > 3) return { error: `Too many arguments. ${usage}` };
  const repo = parts[0]!;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
    return { error: `Repo must be in owner/name form. Got: ${repo}` };
  }
  let maxRuntimeMinutes = 120;
  if (parts.length >= 2) {
    const raw = parts[1]!;
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n) || String(n) !== raw || n < 1 || n > 720) {
      return { error: 'Minutes must be an integer between 1 and 720.' };
    }
    maxRuntimeMinutes = n;
  }
  let maxCostUsd = 5.0;
  if (parts.length >= 3) {
    const c = Number.parseFloat(parts[2]!);
    if (!Number.isFinite(c) || c < 0.01 || c > 100) {
      return { error: 'Cost must be a number between 0.01 and 100.' };
    }
    maxCostUsd = c;
  }
  return { repo, maxRuntimeMinutes, maxCostUsd };
}

async function handleStartPairing(chatId: number, telegramUser: TelegramUser, code: string): Promise<Response> {
  const service = serviceRoleClient();

  const { data: pair, error: pErr } = await service
    .from('telegram_pairing_codes')
    .select('id, user_id, expires_at, used_at')
    .eq('code', code)
    .is('used_at', null)
    .maybeSingle();
  if (pErr) {
    await sendMessage(chatId, 'Pairing failed: lookup error. Try again.');
    return jsonOk({ ok: true });
  }
  if (!pair) {
    await sendMessage(chatId, 'That pairing code is invalid or already used.');
    return jsonOk({ ok: true });
  }
  if (new Date(pair.expires_at).getTime() < Date.now()) {
    await sendMessage(chatId, 'That pairing code has expired. Generate a new one in Roost settings.');
    return jsonOk({ ok: true });
  }

  // Find the user's Personal workspace as the default.
  const { data: personal } = await service
    .from('workspaces')
    .select('id, name')
    .eq('slug', 'personal')
    .maybeSingle();

  // Upsert the link.
  const { error: linkErr } = await service.from('telegram_links').upsert(
    {
      user_id: pair.user_id,
      telegram_user_id: telegramUser.id,
      telegram_username: telegramUser.username ?? null,
      telegram_chat_id: chatId,
      default_workspace_id: personal?.id ?? null,
      current_workspace_id: personal?.id ?? null,
      active: true,
    },
    { onConflict: 'user_id' },
  );
  if (linkErr) {
    await sendMessage(chatId, `Pairing failed: ${linkErr.message}`);
    return jsonOk({ ok: true });
  }

  await service.from('telegram_pairing_codes').update({ used_at: new Date().toISOString() }).eq('id', pair.id);

  const wsLabel = personal?.name ?? 'Personal';
  await sendMessage(
    chatId,
    `Linked. Active workspace: ${wsLabel}.\n\n${HELP_TEXT}`,
  );
  return jsonOk({ ok: true });
}

async function getLinkByTelegramUser(service: ReturnType<typeof serviceRoleClient>, tgUserId: number) {
  const { data, error } = await service
    .from('telegram_links')
    .select('id, user_id, current_workspace_id, default_workspace_id, current_session_id, active')
    .eq('telegram_user_id', tgUserId)
    .maybeSingle();
  if (error) throw new Error(`Telegram link lookup failed: ${error.message}`);
  return data;
}

async function handleSlashCommand(chatId: number, telegramUser: TelegramUser, text: string): Promise<Response> {
  const service = serviceRoleClient();
  const link = await getLinkByTelegramUser(service, telegramUser.id);
  if (!link) {
    if (text.startsWith('/start ')) {
      const code = text.slice('/start '.length).trim();
      if (code.length > 0) return handleStartPairing(chatId, telegramUser, code);
    }
    await sendMessage(chatId, NOT_LINKED_REPLY);
    return jsonOk({ ok: true });
  }

  if (text === '/help') {
    const wsName = await workspaceName(service, link.current_workspace_id);
    await sendMessage(chatId, `${HELP_TEXT}\n\nActive workspace: ${wsName ?? 'none'}.`);
    return jsonOk({ ok: true });
  }
  if (text === '/where') {
    const wsName = await workspaceName(service, link.current_workspace_id);
    await sendMessage(chatId, wsName ? `Active workspace: ${wsName}.` : 'No active workspace.');
    return jsonOk({ ok: true });
  }
  if (text === '/reset') {
    await service.from('telegram_links').update({ current_session_id: null }).eq('id', link.id);
    await sendMessage(chatId, 'New session started. Your next message starts a fresh thread.');
    return jsonOk({ ok: true });
  }
  if (text.startsWith('/use ')) {
    const slug = text.slice('/use '.length).trim().toLowerCase();
    if (!slug) {
      await sendMessage(chatId, 'Usage: /use <slug>. Example: /use personal');
      return jsonOk({ ok: true });
    }
    const { data: ws } = await service.from('workspaces').select('id, name').eq('slug', slug).maybeSingle();
    if (!ws) {
      await sendMessage(chatId, `Unknown workspace: ${slug}.`);
      return jsonOk({ ok: true });
    }
    const { data: member } = await service
      .from('workspace_members')
      .select('role')
      .eq('workspace_id', ws.id)
      .eq('user_id', link.user_id)
      .maybeSingle();
    if (!member) {
      await sendMessage(chatId, `You are not a member of ${ws.name}.`);
      return jsonOk({ ok: true });
    }
    await service
      .from('telegram_links')
      .update({ current_workspace_id: ws.id, current_session_id: null })
      .eq('id', link.id);
    await sendMessage(chatId, `Switched to ${ws.name}.`);
    return jsonOk({ ok: true });
  }
  if (text === '/spawn' || text.startsWith('/spawn ')) {
    return handleSpawn(service, chatId, link, text);
  }
  if (text.startsWith('/start')) {
    const parts = text.split(/\s+/);
    const code = parts[1];
    if (code) return handleStartPairing(chatId, telegramUser, code);
    await sendMessage(chatId, 'You are already linked. Send a message to chat, or /help for commands.');
    return jsonOk({ ok: true });
  }

  await sendMessage(chatId, `Unknown command. ${HELP_TEXT}`);
  return jsonOk({ ok: true });
}

// /spawn: queue a dev_jobs row directly from the user messages in the
// current Telegram session. Workspace-gated to slug='dev' (matching the
// spawn_dev_agent tool's allow-list). Resets the session on success so
// subsequent messages start a clean thread.
async function handleSpawn(
  service: ReturnType<typeof serviceRoleClient>,
  chatId: number,
  link: { id: string; user_id: string; current_workspace_id: string | null; current_session_id: string | null },
  text: string,
): Promise<Response> {
  const { data: ws } = await service
    .from('workspaces')
    .select('id, slug, name')
    .eq('id', link.current_workspace_id ?? '')
    .maybeSingle();
  if (!ws || ws.slug !== 'dev') {
    await sendMessage(chatId, '/spawn is only available in the dev workspace. Switch with `/use dev` first.');
    return jsonOk({ ok: true });
  }

  const arg = text === '/spawn' ? null : text.slice('/spawn '.length).trim();
  const parsed = parseSpawnArgsInline(arg);
  if ('error' in parsed) {
    await sendMessage(chatId, parsed.error);
    return jsonOk({ ok: true });
  }

  if (!link.current_session_id) {
    await sendMessage(chatId, 'No spec found in this thread. Send the spec text first (one or more messages), then /spawn.');
    return jsonOk({ ok: true });
  }

  const { data: msgs, error: mErr } = await service
    .from('messages')
    .select('content, created_at')
    .eq('session_id', link.current_session_id)
    .eq('role', 'user')
    .order('created_at', { ascending: true });
  if (mErr) {
    await sendMessage(chatId, `Failed to read spec messages: ${mErr.message}`);
    return jsonOk({ ok: true });
  }
  const userMsgs = (msgs ?? []).filter((m: { content: string | null }) => typeof m.content === 'string' && m.content.length > 0);
  if (userMsgs.length === 0) {
    await sendMessage(chatId, 'No spec found in this thread. Send the spec text first (one or more messages), then /spawn.');
    return jsonOk({ ok: true });
  }
  const taskSpec = userMsgs.map((m: { content: string }) => m.content).join('\n\n');

  const { data: agent, error: aErr } = await service
    .from('agents')
    .select('id')
    .eq('workspace_id', ws.id)
    .limit(1)
    .maybeSingle();
  if (aErr || !agent) {
    await sendMessage(chatId, `Failed to find an agent for workspace ${ws.name}.`);
    return jsonOk({ ok: true });
  }

  const { data: job, error: jErr } = await service
    .from('dev_jobs')
    .insert({
      workspace_id: ws.id,
      agent_id: agent.id,
      session_id: link.current_session_id,
      user_id: link.user_id,
      task_spec: taskSpec,
      target_repo: parsed.repo,
      target_branch: 'main',
      max_iterations: 50,
      max_cost_usd: parsed.maxCostUsd,
      max_runtime_minutes: parsed.maxRuntimeMinutes,
      agent_provider: 'claude_code',
      status: 'queued',
    })
    .select('id')
    .single();
  if (jErr || !job) {
    await sendMessage(chatId, `Failed to queue dev job: ${jErr?.message ?? 'unknown error'}`);
    return jsonOk({ ok: true });
  }

  await service.from('telegram_links').update({ current_session_id: null }).eq('id', link.id);

  await sendMessage(
    chatId,
    [
      `Queued dev job ${job.id}.`,
      `Spec: ${taskSpec.length} chars from ${userMsgs.length} message(s).`,
      `Repo: ${parsed.repo}`,
      `Limits: ${parsed.maxRuntimeMinutes} min, $${parsed.maxCostUsd.toFixed(2)}.`,
      'Session reset. Your next message starts a fresh thread.',
    ].join('\n'),
  );
  return jsonOk({ ok: true });
}

async function workspaceName(service: ReturnType<typeof serviceRoleClient>, wsId: string | null): Promise<string | null> {
  if (!wsId) return null;
  const { data } = await service.from('workspaces').select('name').eq('id', wsId).maybeSingle();
  return data?.name ?? null;
}

// Streaming pattern: send a placeholder, then edit at most every EDIT_INTERVAL_MS.
const EDIT_INTERVAL_MS = 1500;

async function handleTextMessage(chatId: number, telegramUser: TelegramUser, text: string): Promise<Response> {
  const service = serviceRoleClient();
  const link = await getLinkByTelegramUser(service, telegramUser.id);
  if (!link) {
    await sendMessage(chatId, NOT_LINKED_REPLY);
    return jsonOk({ ok: true });
  }
  if (!link.current_workspace_id) {
    await sendMessage(chatId, 'No active workspace. Use /use <slug> to pick one.');
    return jsonOk({ ok: true });
  }

  const placeholder = await sendMessage(chatId, '...');
  const messageId = placeholder.message_id;

  let buffer = '';
  let lastEditAt = 0;
  let lastEditedText = '...';

  const flushIfDue = async (force: boolean): Promise<void> => {
    const now = Date.now();
    const display = buffer.length > 0 ? buffer : '...';
    if (display === lastEditedText) return;
    if (!force && now - lastEditAt < EDIT_INTERVAL_MS) return;
    try {
      await editMessageText(chatId, messageId, display);
      lastEditAt = now;
      lastEditedText = display;
    } catch (err) {
      console.error('edit failed', err);
    }
  };

  const anthropic = defaultAnthropicClient();

  try {
    const { result } = await runChatCollecting(
      {
        client: service,
        anthropic,
        workspaceId: link.current_workspace_id,
        userId: link.user_id,
        sessionId: link.current_session_id ?? undefined,
        channel: 'telegram',
        channelIdentifier: String(chatId),
        userMessage: text,
      },
      async (ev) => {
        if (ev.type === 'session') {
          await service.from('telegram_links').update({ current_session_id: ev.session_id }).eq('id', link.id);
        }
        if (ev.type === 'token') {
          buffer += ev.text;
          await flushIfDue(false);
        }
        if (ev.type === 'tool_call') {
          await sendMessage(chatId, `Using tool: ${ev.name}...`);
        }
        if (ev.type === 'tool_result' && ev.queued_for_approval) {
          await notifyApprovalNeeded(chatId, ev.action_id ?? '', ev.output);
        }
        if (ev.type === 'budget_exceeded') {
          await sendMessage(chatId, `Daily budget reached: $${ev.spent_usd.toFixed(2)} of $${ev.budget_usd.toFixed(2)}. Try again tomorrow.`);
        }
        if (ev.type === 'error') {
          await sendMessage(chatId, `Sorry, something went wrong: ${ev.message}`);
        }
      },
    );

    await flushIfDue(true);
    if (buffer.length === 0) {
      await editMessageText(chatId, messageId, '(no reply)');
    }
    void result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await editMessageText(chatId, messageId, `Sorry, something went wrong: ${msg}`);
  }

  return jsonOk({ ok: true });
}

async function notifyApprovalNeeded(chatId: number, actionId: string, summary: Record<string, unknown>): Promise<void> {
  const summaryText = `Action queued for approval: ${JSON.stringify(summary)}`;
  const reply_markup: InlineKeyboardMarkup = {
    inline_keyboard: [
      [
        { text: 'Approve', callback_data: `act:approve:${actionId}` },
        { text: 'Reject', callback_data: `act:reject:${actionId}` },
      ],
      [
        { text: 'Preview', callback_data: `act:preview:${actionId}` },
        { text: 'Edit later', callback_data: `act:edit:${actionId}` },
      ],
    ],
  };
  await sendMessage(chatId, summaryText, { reply_markup });
}

async function handleCallbackQuery(cq: TelegramCallbackQuery): Promise<Response> {
  if (!cq.data) {
    await answerCallbackQuery(cq.id);
    return jsonOk({ ok: true });
  }
  const service = serviceRoleClient();
  const link = await getLinkByTelegramUser(service, cq.from.id);
  if (!link) {
    await answerCallbackQuery(cq.id, 'Not linked.');
    return jsonOk({ ok: true });
  }
  const parts = cq.data.split(':');
  if (parts[0] !== 'act' || parts.length < 3) {
    await answerCallbackQuery(cq.id);
    return jsonOk({ ok: true });
  }
  const op = parts[1];
  const actionId = parts.slice(2).join(':');
  const chatId = cq.message?.chat.id;

  // Load action and confirm membership.
  const { data: action, error: aerr } = await service
    .from('outbound_actions')
    .select('id, workspace_id, status, payload, action_type, target')
    .eq('id', actionId)
    .maybeSingle();
  if (aerr || !action) {
    await answerCallbackQuery(cq.id, 'Action not found.');
    return jsonOk({ ok: true });
  }
  const { data: member } = await service
    .from('workspace_members')
    .select('role')
    .eq('workspace_id', action.workspace_id)
    .eq('user_id', link.user_id)
    .maybeSingle();
  if (!member || !['owner', 'admin', 'approver'].includes(String(member.role))) {
    await answerCallbackQuery(cq.id, 'You cannot decide on this action.');
    return jsonOk({ ok: true });
  }

  if (op === 'approve' || op === 'reject') {
    if (action.status !== 'pending') {
      await answerCallbackQuery(cq.id, `Already ${action.status}.`);
      return jsonOk({ ok: true });
    }
    const newStatus = op === 'approve' ? 'approved' : 'rejected';
    await service
      .from('outbound_actions')
      .update({
        status: newStatus,
        decided_at: new Date().toISOString(),
        decided_by_user_id: link.user_id,
        decided_via_channel: 'telegram',
      })
      .eq('id', action.id);
    await answerCallbackQuery(cq.id, op === 'approve' ? 'Approved.' : 'Rejected.');
    if (chatId) {
      await sendMessage(chatId, `Action ${op === 'approve' ? 'approved' : 'rejected'}: ${action.action_type}.`);
    }
    return jsonOk({ ok: true });
  }
  if (op === 'preview') {
    await answerCallbackQuery(cq.id);
    if (chatId) {
      await sendMessage(chatId, `Payload for ${action.action_type}:\n${JSON.stringify(action.payload, null, 2)}`);
    }
    return jsonOk({ ok: true });
  }
  if (op === 'edit') {
    await answerCallbackQuery(cq.id, 'Saved for later. Editing comes in a future phase.');
    return jsonOk({ ok: true });
  }
  await answerCallbackQuery(cq.id);
  return jsonOk({ ok: true });
}

async function handle(req: Request): Promise<Response> {
  if (req.method !== 'POST') return jsonError(405, 'method_not_allowed', 'Use POST.');

  const expected = env('TELEGRAM_WEBHOOK_SECRET');
  const got = req.headers.get('X-Telegram-Bot-Api-Secret-Token') ?? req.headers.get('x-telegram-bot-api-secret-token');
  if (got !== expected) {
    // Silent reject (per spec: a malformed webhook should not error noisily).
    return new Response('forbidden', { status: 403 });
  }

  let update: TelegramUpdate;
  try {
    update = (await req.json()) as TelegramUpdate;
  } catch {
    return jsonError(400, 'invalid_json', 'Body must be JSON.');
  }

  try {
    if (update.callback_query) {
      return await handleCallbackQuery(update.callback_query);
    }
    const msg = update.message;
    if (!msg || !msg.from || msg.from.is_bot) return jsonOk({ ok: true });
    const text = msg.text ?? '';
    if (text.startsWith('/')) {
      return await handleSlashCommand(msg.chat.id, msg.from, text);
    }
    if (text.length === 0) {
      // Phase 5 will handle voice / photos. For now, ignore quietly.
      return jsonOk({ ok: true });
    }
    return await handleTextMessage(msg.chat.id, msg.from, text);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('telegram-webhook error:', msg);
    // Return 200 so Telegram does not retry storms.
    return jsonOk({ ok: false, error: 'internal' });
  }
}

// In tests, callers import this module without `Deno` available, so guard.
const isDeno = typeof (globalThis as { Deno?: unknown }).Deno !== 'undefined';
const skipServe = envOptional('ROOST_SKIP_SERVE') === '1';
if (isDeno && !skipServe) {
  // deno-lint-ignore no-explicit-any
  (globalThis as any).Deno.serve(handle);
}

export { handle };
