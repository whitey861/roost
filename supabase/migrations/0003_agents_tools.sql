-- Roost: agents, tools, agent_tool_overrides

create table if not exists public.tools (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  description text,
  input_schema jsonb not null default '{}'::jsonb,
  handler_type tool_handler_type not null default 'mock',
  handler_config jsonb not null default '{}'::jsonb,
  requires_approval_default boolean not null default false,
  is_outbound boolean not null default false,
  workspace_scope text[] not null default array['*']::text[],
  created_at timestamptz not null default now()
);

create table if not exists public.agents (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  name text not null,
  role_description text,
  system_prompt text not null,
  model text not null default 'claude-opus-4-7',
  allowed_tool_ids uuid[] not null default array[]::uuid[],
  max_runtime_minutes int not null default 30,
  max_cost_per_run_usd numeric not null default 1.00,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create index if not exists agents_workspace_idx on public.agents(workspace_id);

create table if not exists public.agent_tool_overrides (
  agent_id uuid not null references public.agents(id) on delete cascade,
  tool_id uuid not null references public.tools(id) on delete cascade,
  requires_approval boolean not null,
  primary key (agent_id, tool_id)
);
