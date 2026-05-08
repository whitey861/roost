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
prompts/                       per-workspace agent system prompts (markdown)
scripts/
  seed.ts                      idempotent seed (does NOT overwrite system_prompt)
  sync-prompts.ts              push prompts/<slug>.md changes to the database
  set-telegram-webhook.ts      registers the bot webhook with Telegram
tests/                         vitest suite
.devcontainer/                 codespace config (Node 20, Deno, Supabase CLI)
```

`shared/chat-runtime.ts` and `supabase/functions/_shared/chat-runtime.ts`
implement the same flow. The Node copy is canonical for tests; the Deno
copy is what runs in production. Keep them in sync.

## Codespace setup

`.devcontainer/devcontainer.json` provisions a working environment on every
codespace rebuild: Node 20, Deno (via the devcontainers feature), the Supabase
CLI, and `npm install` already done. Open the repo in a Codespace and the
post-create command runs once, then `npm run ci` should pass without further
setup. If `npm run typecheck:edge` complains about a missing `deno`, the
feature did not install; rebuild the codespace.

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
# Safe to re-run: existing agents have role_description/model/allowed_tool_ids
# refreshed but their system_prompt is preserved. Use sync-prompts to push
# prompt changes (see "Agent system prompts" below).
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

## Agent system prompts

Each workspace's default agent has a system prompt living at
`prompts/<workspace_slug>.md`. The file IS the prompt: no frontmatter, no
templating. Edit it like any other markdown file.

The seed script never overwrites `system_prompt` on an existing agent. That
means manual SQL edits and prompt-file changes both stay put across re-seeds.
Pushing prompt-file changes to the database is an explicit step:

```bash
# Sync all five workspaces' prompts.
npm run sync-prompts

# Sync just one.
npm run sync-prompts -- --workspace pmhc

# See diffs without writing.
npm run sync-prompts -- --dry-run
```

The script reports a `before -> after words (+/- delta)` summary per agent
and skips agents where the file already matches the database.

## Default model

Newly seeded agents default to `claude-sonnet-4-6`. Sonnet 4.6 is roughly 5x
cheaper than Opus 4.7 for similar quality on the kinds of tasks Roost agents
do (chat, summarisation, light reasoning, tool routing). To switch a specific
agent back to Opus where the quality lift is worth the cost (long-form
writing, deep analysis):

```sql
update agents set model = 'claude-opus-4-7' where name = 'PMHC Assistant';
```

The shipping migration `0010_default_model_sonnet.sql` updates any agent that
was on the old default to Sonnet 4.6 idempotently; agents already pointing at
a different model (e.g. Haiku) are left alone.

## Phase 3: Knowledge layer (RAG)

Each workspace can hold markdown notes, transcripts, decisions, and reference
material. The chat runtime automatically retrieves the most relevant chunks
per query and prepends them to the agent's system prompt. Agents can also
explicitly call the `search_knowledge` tool when they want more.

### One-time setup

```bash
# 1. Add VOYAGE_API_KEY to .env (https://www.voyageai.com/).
# 2. Apply the new migration so pgvector + knowledge_documents +
#    knowledge_chunks + match_knowledge_chunks RPC are present.
npm run migrate
# 3. Re-run seed to add the search_knowledge tool to every default agent.
npm run seed
```

### Adding knowledge

Drop markdown files into `knowledge/<workspace_slug>/`, then ingest:

```bash
# One file
npm run ingest -- --workspace pmhc --file knowledge/pmhc/ai-strategy.md

# Whole workspace
npm run ingest -- --workspace pmhc

# Everything across all workspaces
npm run ingest -- --all

# Force re-chunk and re-embed even if the file is older than chunked_at
npm run ingest -- --workspace pmhc --force

# Chunk only, no Voyage calls, no Supabase writes (useful for tuning)
npm run ingest -- --workspace pmhc --dry-run
```

Optional frontmatter at the top of any markdown file:

```yaml
---
title: AI Strategy 2026-2030
tags: [strategy, board-decisions]
source_url: https://intranet.example/strategy
source_type: markdown
---
```

`title` defaults to the filename. `source_type` defaults to `markdown`.

### How retrieval works

For every chat message the runtime does:

1. Embed the user's message with Voyage (`voyage-3`, 1024-dim, query mode).
2. Call the `match_knowledge_chunks` RPC for the workspace, top 4 chunks.
3. Filter by similarity threshold 0.4 (drops noise).
4. If hits remain, format them as a `<workspace_knowledge>` block and prepend
   to the agent's system prompt for that turn only.
5. If `VOYAGE_API_KEY` is missing or Voyage errors out, retrieval is a
   graceful no-op: the chat continues without injected context.

Agents can also call `search_knowledge` directly. The internal dispatch
runs the same retrieval with caller-controlled `query` and `max_results`,
returns the hits as JSON, and feeds the result back into the model.

### Ingesting a Claude.ai conversations export

Claude.ai → Settings → Privacy → Export data emails a ZIP. Extract it,
then:

```bash
# Classify only, no writes (sanity check the classifications first)
npm run ingest-claude-export -- --path /path/to/extracted/export --dry-run

# Full ingest
npm run ingest-claude-export -- --path /path/to/extracted/export

# Re-classify and re-ingest (use after tweaking the classifier prompt)
npm run ingest-claude-export -- --path ... --force

# Process only the first N conversations (testing)
npm run ingest-claude-export -- --path ... --limit 10

# Skip personal-classified conversations
npm run ingest-claude-export -- --path ... --exclude-personal

# Re-ingest only the projects/ subfolders (skip top-level conversations.json)
npm run ingest-claude-export -- --path ... --projects-only
```

A Claude.ai export contains `conversations.json` at the top, plus a
`projects/` directory with one subfolder per Project, each holding its own
`conversations.json` (and an optional `project.json` with the friendly name).
The script processes the top-level batch first, then iterates the project
folders in name order. For each conversation in a project, the project name
is:

- passed to the classifier as a strong-context line in the user prompt (a
  Claude.ai Project usually maps cleanly to one workspace);
- written to `knowledge_documents.metadata.project` so retrieved chunks can
  show their origin;
- added to the document's tags as `project:<name>`.

What happens per conversation:

1. Build `source_ref = claude_export:<uuid>` and check whether the
   document already exists. If yes and not `--force`, skip without
   spending classifier tokens.
2. Otherwise, ask Claude Haiku (`CLAUDE_CLASSIFIER_MODEL`, default
   `claude-haiku-4-5-20251001`) to classify the conversation against
   the five workspaces using just the title + first user message +
   first assistant message (each truncated). Confidence below 0.5
   collapses to `none`.
3. `none` skips. `multiple` ingests into the primary workspace and
   tags the others in the document's `metadata.secondary_workspaces`.
   Single workspace results ingest into that one.
4. The conversation is rendered as markdown (one `##` section per
   message), prefixed with the chunker-friendly title block, then
   passed through the existing chunk-and-embed pipeline.

At the end the script prints a workspace-by-workspace summary plus
embedding cost (Voyage) and classifier cost (Haiku).

Re-running the script without `--force` is idempotent: already-ingested
conversations are detected by their UUID and skipped.

Tuning knobs (env vars):

- `CLAUDE_CLASSIFIER_MODEL` (default `claude-haiku-4-5-20251001`):
  pick a different classifier if you want more accuracy at higher cost.
- `ROOST_CLASSIFIER_MIN_CONFIDENCE` (default `0.5`): conversations
  classified with confidence below this are remapped to `none`.
  Lower it (e.g. `0.3`) if Haiku is conservative and legitimate
  classifications are getting flipped.
- `ROOST_DEBUG_CLASSIFIER=1`: dumps the raw classifier response,
  the extracted JSON, the parsed classification, and any
  threshold flips for every conversation. Use this whenever
  classifications look wrong; the output explains exactly what
  the model returned.

The live classifier uses Anthropic's assistant-prefill technique
(starts the assistant message with `{`) to force pure JSON output,
so markdown fences and stray prose around the JSON shouldn't
happen in practice; the parser also tolerates them as a backstop.

Cost guide: classifier is ~$0.0006 per conversation (Haiku 4.5);
embedding is dominated by long conversations and chunked at ~600
tokens. For ~300 conversations expect ~$0.20 total.

### Reindex (after upgrading the embedding model or chunker)

```bash
npm run reindex -- --workspace pmhc
npm run reindex -- --dry-run
```

Reindex re-chunks each document from `content_md` (stored at ingest time)
and re-embeds. No file system access required.

### `knowledge/personal/`

`knowledge/personal/*` is gitignored. Drop private notes there; they stay
local. The other four workspace folders are tracked.

### Cost notes

- Embedding: ~$0.06 per million tokens. 50 documents averaging 2k tokens
  each is ~100k tokens, ~0.6 cents to embed.
- Per-chat retrieval: 4 chunks of ~600 tokens each = ~2400 added tokens
  per turn. On Opus that's ~3.6 cents per turn extra; on Sonnet ~0.7
  cents. Switch agents to Sonnet 4.6 for general chat to keep this in
  check.
- Storage: pgvector chunks are tiny in DB terms; even 10,000 chunks is
  comfortably under 50MB.

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
- chat runtime knowledge auto-injection and search_knowledge dispatch
- history reconstruction (DB rows to Claude messages)
- markdown chunker (sections, overlap, header-less docs)
- Voyage embeddings client (batching, retries, auth failure)
- knowledge retrieval (top-K, workspace filter, threshold, graceful failure)
- ingestion end-to-end (create, skip, replace, force, frontmatter)
- Claude.ai export parser, classifier, markdown renderer, and ingest
  pipeline (single-workspace, multiple, none, force, dry-run,
  exclude-personal, idempotent re-runs)
- Telegram slash and callback parsers, pairing code generator
- runtime parity script and its helper edge cases

The tests use a Node-level fake of `SupabaseClient` (`tests/fakes/`) and
a scripted fake of `AnthropicClient`. No real API calls are made.

## Local development guardrails

Run before pushing:

```bash
npm run ci
```

This runs four steps in order: parity check, Node typecheck, Edge
Function typecheck, then the Vitest suite. Each is also runnable
individually.

- `npm run check:parity` - confirms paired Node/Deno files haven't
  drifted. Each pair contains a canonical block delimited by
  `// SHARED_RUNTIME_START` and `// SHARED_RUNTIME_END` markers
  (both must appear on their own line). The script strips comments
  and whitespace, hashes each block, and fails if any pair's hashes
  differ. Imports and adapter glue live outside the markers and may
  differ between Node and Deno; business logic lives inside and must
  be identical. Currently checked pairs:
  - `shared/chat-runtime.ts` ↔ `supabase/functions/_shared/chat-runtime.ts`
  - `shared/retrieval.ts` ↔ `supabase/functions/_shared/retrieval.ts`
- `npm run typecheck` - runs TypeScript against everything outside
  `supabase/functions/` (shared modules, scripts, tests).
- `npm run typecheck:edge` - runs `deno check` on every Edge Function
  entry point. Requires `deno` on PATH. The script materialises
  npm dependencies via `npm ci` if `node_modules` is missing, then
  asks Deno to resolve `npm:` specifiers from there.
- `npm test` - runs Vitest.

If you add or rename files in `supabase/functions/`, the typecheck
script auto-discovers them. If you add a new Edge Function and it
fails `deno check`, fix the import or type issue. Don't exclude the
file; don't disable the check.

The same four steps run on every push and PR via
`.github/workflows/ci.yml`. Tests use the in-memory fakes so CI
needs no Supabase or Anthropic secrets.

## Notes

- Both copies of the chat runtime (Node and Deno) implement the same
  flow. Edits in one must be mirrored in the other. The parity script
  enforces this; see "Local development guardrails" above.
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
