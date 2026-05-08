-- Roost: default model switch from Opus 4.7 to Sonnet 4.6.
--
-- Sonnet 4.6 is ~5x cheaper than Opus 4.7 for similar quality on the kinds
-- of work Roost agents do. To switch a specific agent back to Opus where
-- the quality lift is worth the cost (long-form writing, deep analysis):
--
--   update agents set model = 'claude-opus-4-7' where name = '...';

alter table public.agents alter column model set default 'claude-sonnet-4-6';

-- Backfill: migrate any agent still pointing at the old default. Agents
-- explicitly switched to a different model (e.g. Haiku for cheap tasks)
-- are left alone.
update public.agents set model = 'claude-sonnet-4-6' where model = 'claude-opus-4-7';
