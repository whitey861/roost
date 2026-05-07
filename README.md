# Roost backend

Multi-workspace AI agent platform: backend foundations and Telegram channel.

This repo covers Phase 1 (schema, chat Edge Function, mock tools, budget
enforcement) and Phase 2 (Telegram webhook, pairing, slash commands,
approval keyboards). The Lovable frontend is a separate repo.

## Stack

- Node.js + TypeScript (strict)
- Supabase (Postgres, Auth, Edge Functions on Deno)
- Anthropic Claude API
- Vitest for unit tests

## Repo layout

```
supabase/
  migrations/                  numbered SQL migrations (Phase 1 schema)
  functions/
    chat/                      POST /chat: web SSE streaming
    telegram-webhook/          POST /telegram-webhook
    pair-telegram/             POST /pair-telegram
    _shared/                   auth, supabase client, anthropic client, runtime
shared/                        Node-side TypeScript modules (canonical logic)
scripts/
  seed.ts                      idempotent seed
  set-telegram-webhook.ts      registers the bot webhook with Telegram
tests/                         vitest suite
```

`shared/chat-runtime.ts` and `supabase/functions/_shared/chat-runtime.ts`
implement the same flow. The Node copy is canonical for tests; the Deno
copy is what runs in production. Keep them in sync.

## Local setup

Prereqs: Node 20+, pnpm or npm, Supabase CLI, a Telegram bot token (Phase 2).

```bash
cp .env.example .env
# fill in: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY,
# ANTHROPIC_API_KEY, TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET, PUBLIC_BASE_URL

npm install

# Start a local Supabase stack (Postgres, Auth, Edge runtime).
supabase start

# Apply migrations against the local stack.
npm run migrate            # supabase db reset --local

# Seed workspaces, default agents, mock tools, admin user.
npm run seed

# Run the Edge Functions locally.
npm run dev:functions
```

Local Supabase prints its anon and service-role keys when `supabase start`
finishes. Copy them into `.env`.

## Test admin credentials

Seeded by `scripts/seed.ts`:

- Email: `paul@roost.local`
- Password: `roost-dev-password-change-me`

Sign in via Supabase Auth to get a JWT; pass it to the chat endpoint as
`Authorization: Bearer <jwt>`.

## Calling the chat endpoint

```bash
JWT=...         # supabase access token for paul@roost.local
WS=...          # workspace id (look up by slug in the workspaces table)

curl -N -X POST "$SUPABASE_URL/functions/v1/chat" \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d "{\"workspace_id\":\"$WS\",\"message\":\"Hello\"}"
```

The response is `text/event-stream`. Each event line is JSON:

- `session` - emits the session id (use it on the next call to continue)
- `token` - assistant text delta
- `tool_call` - assistant requested a tool, with parsed input
- `tool_result` - tool output (or `queued_for_approval: true` for outbound tools)
- `budget_exceeded` - daily budget reached; loop stops
- `error` - runtime or API error
- `done` - final usage and cost

To test the tool loop, ask the assistant to "search for X". It will
invoke `mock_search`, the tool returns three fake results, and the
assistant summarises them.

To test approval gating, ask the assistant to "send an email to a@b.com
saying hi". `mock_send_email` is outbound, so the runtime queues an
`outbound_actions` row with `status='pending'` and the assistant tells
you it has been queued.

## Phase 2: Telegram

```bash
# 1. Create the bot with @BotFather, paste the token in .env.
# 2. Pick any random secret for TELEGRAM_WEBHOOK_SECRET (use a long string).
# 3. Set PUBLIC_BASE_URL to the publicly reachable Supabase URL.
npm run set-webhook

# 4. From the frontend (or curl), call POST /pair-telegram while
#    authenticated as the admin. It returns a 6-digit code.
# 5. In Telegram, send `/start <code>` to your bot. It links your
#    Roost user to your Telegram account and sets Personal as the
#    default workspace.
# 6. Send "Hello" - the bot streams a reply by editing a single
#    message at most every 1.5s.
```

Slash commands:

- `/use <slug>` - switch active workspace for this chat
- `/where` - show the active workspace
- `/help` - list commands
- `/reset` - start a fresh chat session

Approval keyboard: when the chat runtime queues an outbound action,
the bot sends a message with four buttons. Approve and Reject both
update `outbound_actions`; Preview shows the payload; Edit later
acknowledges (full Edit later flow lands in Phase 5).

## Triggering a fake outbound action via SQL

To verify the approval keyboard end-to-end without a chat round trip:

```sql
insert into public.outbound_actions
  (workspace_id, action_type, target, payload, requires_approval, status)
values
  ('<personal-workspace-id>', 'mock_send_email', 'me@example.com',
   '{"subject":"test","body":"hi"}'::jsonb, true, 'pending');
```

You'll need to manually call the bot's `notifyApprovalNeeded` flow,
or wait for Phase 3 which wires real-time triggers into the Telegram
notifier.

## Tests

```bash
npm test
```

The suite covers:

- pricing cost math
- mock tool dispatch and pure approval decision logic
- migration idempotency and required tables
- seed shape (workspace count, agents, tools)
- chat runtime: no-tool happy path, tool call loop, approval gating,
  budget enforcement, day-rollover behaviour
- history reconstruction (DB rows to Claude messages)
- Telegram slash and callback parsers, pairing code generator

The tests use a Node-level fake of `SupabaseClient` (`tests/fakes/`) and
a scripted fake of `AnthropicClient`. No real API calls are made.

## Notes

- Both copies of the chat runtime (Node and Deno) implement the same
  flow. Edits in one must be mirrored in the other. There's a comment
  at the top of each file calling this out.
- All money-spending operations check `workspaces.daily_spent_usd`
  before firing and update it after. Budget rollover is daily at
  the first request after midnight UTC.
- Plain Australian English. No em dashes anywhere in user-facing
  strings or seed prompts.

## What's deferred

- AWS worker for long-running and scheduled jobs (Phase 3)
- Real tool implementations beyond mocks (Phase 3)
- Voice notes, file attachments on Telegram (Phase 5)
- pg_cron triggers, morning brief, SES email digest (Phase 6)
- Slack and email channels (later)
