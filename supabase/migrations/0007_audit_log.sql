-- Roost: audit_log

create table if not exists public.audit_log (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references public.workspaces(id) on delete set null,
  actor_type audit_actor_type not null,
  actor_id text,
  action text not null,
  target_table text,
  target_id uuid,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists audit_log_workspace_idx on public.audit_log(workspace_id, created_at desc);
