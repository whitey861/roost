-- Roost: RLS policies
-- Service role bypasses all RLS by design (used by Edge Functions).
-- Authenticated users see only data scoped to their workspace memberships
-- or their own user_id.

-- Helper: check if the current user is a member of a workspace.
create or replace function public.is_workspace_member(ws_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.workspace_members
    where workspace_id = ws_id
      and user_id = auth.uid()
  );
$$;

-- Helper: check if current user has any of the provided roles in a workspace.
create or replace function public.has_workspace_role(ws_id uuid, roles workspace_role[])
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.workspace_members
    where workspace_id = ws_id
      and user_id = auth.uid()
      and role = any(roles)
  );
$$;

-- profiles: own row only
alter table public.profiles enable row level security;
drop policy if exists profiles_self_select on public.profiles;
create policy profiles_self_select on public.profiles
  for select to authenticated
  using (id = auth.uid());
drop policy if exists profiles_self_upsert on public.profiles;
create policy profiles_self_upsert on public.profiles
  for insert to authenticated
  with check (id = auth.uid());
drop policy if exists profiles_self_update on public.profiles;
create policy profiles_self_update on public.profiles
  for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

-- workspaces: members can read, owner/admin can mutate
alter table public.workspaces enable row level security;
drop policy if exists workspaces_member_select on public.workspaces;
create policy workspaces_member_select on public.workspaces
  for select to authenticated
  using (public.is_workspace_member(id));
drop policy if exists workspaces_admin_update on public.workspaces;
create policy workspaces_admin_update on public.workspaces
  for update to authenticated
  using (public.has_workspace_role(id, array['owner','admin']::workspace_role[]))
  with check (public.has_workspace_role(id, array['owner','admin']::workspace_role[]));

-- workspace_members: members can read their workspace's roster; owners/admins manage
alter table public.workspace_members enable row level security;
drop policy if exists workspace_members_select on public.workspace_members;
create policy workspace_members_select on public.workspace_members
  for select to authenticated
  using (public.is_workspace_member(workspace_id));
drop policy if exists workspace_members_admin_write on public.workspace_members;
create policy workspace_members_admin_write on public.workspace_members
  for all to authenticated
  using (public.has_workspace_role(workspace_id, array['owner','admin']::workspace_role[]))
  with check (public.has_workspace_role(workspace_id, array['owner','admin']::workspace_role[]));

-- agents: members read; owner/admin write
alter table public.agents enable row level security;
drop policy if exists agents_member_select on public.agents;
create policy agents_member_select on public.agents
  for select to authenticated
  using (public.is_workspace_member(workspace_id));
drop policy if exists agents_admin_write on public.agents;
create policy agents_admin_write on public.agents
  for all to authenticated
  using (public.has_workspace_role(workspace_id, array['owner','admin']::workspace_role[]))
  with check (public.has_workspace_role(workspace_id, array['owner','admin']::workspace_role[]));

-- tools: visible to any authenticated user (registry); only service role writes
alter table public.tools enable row level security;
drop policy if exists tools_authenticated_select on public.tools;
create policy tools_authenticated_select on public.tools
  for select to authenticated
  using (true);

-- agent_tool_overrides: scoped via parent agent's workspace
alter table public.agent_tool_overrides enable row level security;
drop policy if exists agent_tool_overrides_select on public.agent_tool_overrides;
create policy agent_tool_overrides_select on public.agent_tool_overrides
  for select to authenticated
  using (
    exists (
      select 1 from public.agents a
      where a.id = agent_tool_overrides.agent_id
        and public.is_workspace_member(a.workspace_id)
    )
  );
drop policy if exists agent_tool_overrides_admin_write on public.agent_tool_overrides;
create policy agent_tool_overrides_admin_write on public.agent_tool_overrides
  for all to authenticated
  using (
    exists (
      select 1 from public.agents a
      where a.id = agent_tool_overrides.agent_id
        and public.has_workspace_role(a.workspace_id, array['owner','admin']::workspace_role[])
    )
  )
  with check (
    exists (
      select 1 from public.agents a
      where a.id = agent_tool_overrides.agent_id
        and public.has_workspace_role(a.workspace_id, array['owner','admin']::workspace_role[])
    )
  );

-- sessions: members of workspace can read; user can read own sessions
alter table public.sessions enable row level security;
drop policy if exists sessions_member_select on public.sessions;
create policy sessions_member_select on public.sessions
  for select to authenticated
  using (public.is_workspace_member(workspace_id));

-- messages: scoped via parent session's workspace
alter table public.messages enable row level security;
drop policy if exists messages_member_select on public.messages;
create policy messages_member_select on public.messages
  for select to authenticated
  using (
    exists (
      select 1 from public.sessions s
      where s.id = messages.session_id
        and public.is_workspace_member(s.workspace_id)
    )
  );

-- jobs / agent_runs / artifacts: workspace-scoped read
alter table public.jobs enable row level security;
drop policy if exists jobs_member_select on public.jobs;
create policy jobs_member_select on public.jobs
  for select to authenticated
  using (public.is_workspace_member(workspace_id));

alter table public.agent_runs enable row level security;
drop policy if exists agent_runs_member_select on public.agent_runs;
create policy agent_runs_member_select on public.agent_runs
  for select to authenticated
  using (
    exists (
      select 1 from public.jobs j
      where j.id = agent_runs.job_id
        and public.is_workspace_member(j.workspace_id)
    )
  );

alter table public.artifacts enable row level security;
drop policy if exists artifacts_member_select on public.artifacts;
create policy artifacts_member_select on public.artifacts
  for select to authenticated
  using (
    (job_id is not null and exists (
      select 1 from public.jobs j
      where j.id = artifacts.job_id
        and public.is_workspace_member(j.workspace_id)
    ))
    or
    (session_id is not null and exists (
      select 1 from public.sessions s
      where s.id = artifacts.session_id
        and public.is_workspace_member(s.workspace_id)
    ))
  );

-- outbound_actions: members read; approvers/admins/owners can update decisions
alter table public.outbound_actions enable row level security;
drop policy if exists outbound_actions_member_select on public.outbound_actions;
create policy outbound_actions_member_select on public.outbound_actions
  for select to authenticated
  using (public.is_workspace_member(workspace_id));
drop policy if exists outbound_actions_approver_update on public.outbound_actions;
create policy outbound_actions_approver_update on public.outbound_actions
  for update to authenticated
  using (public.has_workspace_role(workspace_id, array['owner','admin','approver']::workspace_role[]))
  with check (public.has_workspace_role(workspace_id, array['owner','admin','approver']::workspace_role[]));

-- audit_log: members read; only service role writes
alter table public.audit_log enable row level security;
drop policy if exists audit_log_member_select on public.audit_log;
create policy audit_log_member_select on public.audit_log
  for select to authenticated
  using (workspace_id is null or public.is_workspace_member(workspace_id));

-- telegram_links: own row only
alter table public.telegram_links enable row level security;
drop policy if exists telegram_links_self_select on public.telegram_links;
create policy telegram_links_self_select on public.telegram_links
  for select to authenticated
  using (user_id = auth.uid());
drop policy if exists telegram_links_self_update on public.telegram_links;
create policy telegram_links_self_update on public.telegram_links
  for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- telegram_pairing_codes: own row only
alter table public.telegram_pairing_codes enable row level security;
drop policy if exists telegram_pairing_codes_self_select on public.telegram_pairing_codes;
create policy telegram_pairing_codes_self_select on public.telegram_pairing_codes
  for select to authenticated
  using (user_id = auth.uid());
