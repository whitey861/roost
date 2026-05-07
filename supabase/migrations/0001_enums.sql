-- Roost: enum types
-- Idempotent: every CREATE TYPE wrapped in DO blocks that check pg_type first.

do $$
begin
  if not exists (select 1 from pg_type where typname = 'workspace_approval_mode') then
    create type workspace_approval_mode as enum ('all_outbound', 'allowlist', 'autonomous');
  end if;
end$$;

do $$
begin
  if not exists (select 1 from pg_type where typname = 'workspace_role') then
    create type workspace_role as enum ('owner', 'admin', 'approver', 'member', 'viewer');
  end if;
end$$;

do $$
begin
  if not exists (select 1 from pg_type where typname = 'tool_handler_type') then
    create type tool_handler_type as enum ('mock', 'internal', 'http', 'edge_function');
  end if;
end$$;

do $$
begin
  if not exists (select 1 from pg_type where typname = 'channel_type') then
    create type channel_type as enum ('web', 'telegram');
  end if;
end$$;

do $$
begin
  if not exists (select 1 from pg_type where typname = 'message_role') then
    create type message_role as enum ('user', 'assistant', 'tool_call', 'tool_result', 'system_event');
  end if;
end$$;

do $$
begin
  if not exists (select 1 from pg_type where typname = 'job_status') then
    create type job_status as enum ('queued', 'running', 'complete', 'failed', 'cancelled', 'awaiting_approval');
  end if;
end$$;

do $$
begin
  if not exists (select 1 from pg_type where typname = 'artifact_type') then
    create type artifact_type as enum ('draft', 'report', 'code', 'data', 'file');
  end if;
end$$;

do $$
begin
  if not exists (select 1 from pg_type where typname = 'outbound_action_status') then
    create type outbound_action_status as enum ('pending', 'approved', 'rejected', 'executed', 'failed');
  end if;
end$$;

do $$
begin
  if not exists (select 1 from pg_type where typname = 'audit_actor_type') then
    create type audit_actor_type as enum ('user', 'agent', 'system');
  end if;
end$$;
