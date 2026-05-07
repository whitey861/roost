-- Roost: telegram_links, telegram_pairing_codes

create table if not exists public.telegram_links (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references auth.users(id) on delete cascade,
  telegram_user_id bigint not null unique,
  telegram_username text,
  telegram_chat_id bigint,
  default_workspace_id uuid references public.workspaces(id) on delete set null,
  current_workspace_id uuid references public.workspaces(id) on delete set null,
  current_session_id uuid references public.sessions(id) on delete set null,
  linked_at timestamptz not null default now(),
  active boolean not null default true
);

create index if not exists telegram_links_tg_user_idx on public.telegram_links(telegram_user_id);

create table if not exists public.telegram_pairing_codes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  code text not null,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists telegram_pairing_codes_code_idx on public.telegram_pairing_codes(code) where used_at is null;
