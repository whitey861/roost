-- Roost: sessions, messages

create table if not exists public.sessions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  agent_id uuid not null references public.agents(id) on delete restrict,
  channel_type channel_type not null,
  channel_identifier text,
  title text,
  closed boolean not null default false,
  created_at timestamptz not null default now(),
  last_message_at timestamptz not null default now()
);

create index if not exists sessions_workspace_idx on public.sessions(workspace_id);
create index if not exists sessions_user_idx on public.sessions(user_id);
create index if not exists sessions_channel_idx on public.sessions(channel_type, channel_identifier);

create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions(id) on delete cascade,
  role message_role not null,
  content text,
  tool_call_id text,
  tool_name text,
  tool_input jsonb,
  tool_output jsonb,
  tokens_in int,
  tokens_out int,
  cost_usd numeric,
  model text,
  created_at timestamptz not null default now()
);

create index if not exists messages_session_idx on public.messages(session_id, created_at);
