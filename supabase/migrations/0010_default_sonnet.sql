-- Roost: switch the default agent model from Opus 4.7 to Sonnet 4.6.
-- Idempotent: re-running is a no-op once the default and rows have
-- been flipped.

alter table public.agents alter column model set default 'claude-sonnet-4-6';

update public.agents
set model = 'claude-sonnet-4-6'
where model = 'claude-opus-4-7';
