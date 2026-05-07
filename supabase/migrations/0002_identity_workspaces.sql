-- Roost: profiles, workspaces, workspace_members
create extension if not exists "pgcrypto";

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  created_at timestamptz not null default now()
);

create table if not exists public.workspaces (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  description text,
  approval_mode workspace_approval_mode not null default 'all_outbound',
  daily_token_budget_usd numeric not null default 5.00,
  daily_spent_usd numeric not null default 0,
  daily_spent_reset_at date not null default current_date,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create index if not exists workspaces_slug_idx on public.workspaces(slug);

create table if not exists public.workspace_members (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role workspace_role not null default 'member',
  created_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

create index if not exists workspace_members_user_idx on public.workspace_members(user_id);
