-- Roost Phase 5: dev_jobs and dev_job_notifications.
--
-- A dev_job is a unit of autonomous coding work queued by a chat agent
-- (via the spawn_dev_agent tool) for a worker process to pick up. The
-- worker leases a job atomically, runs it, and writes results back here.
-- Notifications are inserted in a separate table so the dispatch loop
-- can be retried independently of the job execution.
--
-- Idempotent: every CREATE wrapped in `if not exists` and DO blocks.

create table if not exists public.dev_jobs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  agent_id uuid not null references public.agents(id) on delete restrict,
  session_id uuid references public.sessions(id) on delete set null,
  user_id uuid not null references auth.users(id) on delete cascade,

  -- Inputs supplied by the caller (the spawn_dev_agent tool handler).
  task_spec text not null,
  target_repo text not null,
  target_branch text default 'main',
  agent_provider text not null default 'claude_code',
  agent_provider_config jsonb not null default '{}'::jsonb,
  max_iterations int default 50,
  max_cost_usd numeric(10,4) default 5.00,
  max_runtime_minutes int default 120,

  -- State machine. 'queued' is what the worker polls; 'running' means a
  -- worker holds the lease; the rest are terminal.
  status text not null default 'queued'
    check (status in ('queued','running','completed','failed','cancelled','timeout')),
  leased_by text,
  leased_at timestamptz,
  lease_expires_at timestamptz,

  -- Results filled in once the worker is done.
  branch_name text,
  pr_url text,
  pr_number int,
  files_changed int,
  tests_passed boolean,
  tests_summary text,
  cost_usd numeric(10,4),
  iterations_used int,
  runtime_seconds int,
  agent_summary text,
  worker_log text,
  error_message text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz
);

create index if not exists dev_jobs_status_idx
  on public.dev_jobs(status, created_at);

create index if not exists dev_jobs_lease_idx
  on public.dev_jobs(leased_by, lease_expires_at)
  where status = 'running';

create index if not exists dev_jobs_workspace_idx
  on public.dev_jobs(workspace_id, created_at desc);

create table if not exists public.dev_job_notifications (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.dev_jobs(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  channel text not null check (channel in ('telegram','web')),
  payload jsonb not null,
  delivered boolean not null default false,
  delivery_attempts int not null default 0,
  delivered_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists dev_job_notifications_pending_idx
  on public.dev_job_notifications(delivered, created_at)
  where delivered = false;

-- RLS: a user reads their own dev_jobs and notifications. The worker uses
-- the service role and bypasses these policies entirely.
alter table public.dev_jobs enable row level security;
drop policy if exists dev_jobs_self_select on public.dev_jobs;
create policy dev_jobs_self_select on public.dev_jobs
  for select to authenticated
  using (user_id = auth.uid() or public.is_workspace_member(workspace_id));

alter table public.dev_job_notifications enable row level security;
drop policy if exists dev_job_notifications_self_select on public.dev_job_notifications;
create policy dev_job_notifications_self_select on public.dev_job_notifications
  for select to authenticated
  using (user_id = auth.uid());
