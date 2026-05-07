-- Roost: jobs, agent_runs, artifacts, outbound_actions

create table if not exists public.jobs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  agent_id uuid not null references public.agents(id) on delete restrict,
  parent_session_id uuid references public.sessions(id) on delete set null,
  parent_job_id uuid references public.jobs(id) on delete set null,
  status job_status not null default 'queued',
  scheduled_for timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  input jsonb not null default '{}'::jsonb,
  error_text text,
  created_at timestamptz not null default now()
);

create index if not exists jobs_workspace_idx on public.jobs(workspace_id);
create index if not exists jobs_status_idx on public.jobs(status);

create table if not exists public.agent_runs (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.jobs(id) on delete cascade,
  step_number int not null,
  tokens_in int,
  tokens_out int,
  cost_usd numeric,
  model text,
  created_at timestamptz not null default now()
);

create index if not exists agent_runs_job_idx on public.agent_runs(job_id, step_number);

create table if not exists public.artifacts (
  id uuid primary key default gen_random_uuid(),
  job_id uuid references public.jobs(id) on delete set null,
  session_id uuid references public.sessions(id) on delete set null,
  type artifact_type not null,
  title text,
  content_md text,
  file_path text,
  created_at timestamptz not null default now()
);

create table if not exists public.outbound_actions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  session_id uuid references public.sessions(id) on delete set null,
  job_id uuid references public.jobs(id) on delete set null,
  action_type text not null,
  target text,
  payload jsonb not null default '{}'::jsonb,
  requires_approval boolean not null default true,
  status outbound_action_status not null default 'pending',
  requested_at timestamptz not null default now(),
  decided_at timestamptz,
  executed_at timestamptz,
  decided_by_user_id uuid references auth.users(id) on delete set null,
  decided_via_channel text,
  decision_note text,
  result jsonb
);

create index if not exists outbound_actions_workspace_idx on public.outbound_actions(workspace_id, status);
