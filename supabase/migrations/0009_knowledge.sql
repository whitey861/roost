-- Roost: knowledge layer (RAG).
-- pgvector tables + indexes + RLS + RPC for top-K cosine retrieval.

create extension if not exists vector;

do $$
begin
  if not exists (select 1 from pg_type where typname = 'knowledge_source_type') then
    create type knowledge_source_type as enum (
      'markdown',
      'claude_export',
      'pasted_note',
      'web_page',
      'file_upload'
    );
  end if;
end$$;

create table if not exists public.knowledge_documents (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  title text not null,
  source_type knowledge_source_type not null default 'markdown',
  source_ref text not null,
  source_url text,
  content_md text,
  tags text[] not null default array[]::text[],
  chunked_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, source_ref)
);

create index if not exists knowledge_documents_workspace_idx
  on public.knowledge_documents(workspace_id);

create table if not exists public.knowledge_chunks (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.knowledge_documents(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  chunk_index int not null,
  content text not null,
  tokens int,
  embedding vector(1024) not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists knowledge_chunks_workspace_idx
  on public.knowledge_chunks(workspace_id);

create index if not exists knowledge_chunks_document_idx
  on public.knowledge_chunks(document_id, chunk_index);

create index if not exists knowledge_chunks_embedding_idx
  on public.knowledge_chunks
  using hnsw (embedding vector_cosine_ops);

-- RLS
alter table public.knowledge_documents enable row level security;
drop policy if exists knowledge_documents_member_select on public.knowledge_documents;
create policy knowledge_documents_member_select on public.knowledge_documents
  for select to authenticated
  using (public.is_workspace_member(workspace_id));
drop policy if exists knowledge_documents_admin_write on public.knowledge_documents;
create policy knowledge_documents_admin_write on public.knowledge_documents
  for all to authenticated
  using (public.has_workspace_role(workspace_id, array['owner','admin']::workspace_role[]))
  with check (public.has_workspace_role(workspace_id, array['owner','admin']::workspace_role[]));

alter table public.knowledge_chunks enable row level security;
drop policy if exists knowledge_chunks_member_select on public.knowledge_chunks;
create policy knowledge_chunks_member_select on public.knowledge_chunks
  for select to authenticated
  using (public.is_workspace_member(workspace_id));
-- Chunks are written exclusively by service role (ingestion). No
-- authenticated INSERT/UPDATE/DELETE policy is created, which means
-- non-service-role clients cannot mutate chunks even with RLS.

-- RPC: top-K cosine similarity, scoped to a workspace.
-- security invoker so RLS still applies via the calling auth context;
-- service role naturally bypasses RLS.
create or replace function public.match_knowledge_chunks(
  query_embedding vector(1024),
  ws_id uuid,
  match_count int
)
returns table (
  document_id uuid,
  document_title text,
  source_ref text,
  source_url text,
  chunk_index int,
  content text,
  similarity float
)
language sql
stable
security invoker
set search_path = public
as $$
  select
    c.document_id,
    d.title as document_title,
    d.source_ref,
    d.source_url,
    c.chunk_index,
    c.content,
    (1 - (c.embedding <=> query_embedding))::float as similarity
  from public.knowledge_chunks c
  join public.knowledge_documents d on d.id = c.document_id
  where c.workspace_id = ws_id
  order by c.embedding <=> query_embedding
  limit match_count;
$$;

grant execute on function public.match_knowledge_chunks(vector, uuid, int) to authenticated, service_role;
