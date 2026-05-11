-- Roost: register the `generate_image` tool that produces images via the
-- Recraft API. handler_type='internal' matches the pattern used by other
-- locally-dispatched tools (e.g. search_knowledge): the runtime dispatches
-- to a TypeScript handler that calls Recraft and returns the image URL.
--
-- Idempotent: the unique(name) constraint on `tools` means re-running the
-- migration is a no-op once the row is present.

insert into public.tools (
  name,
  description,
  input_schema,
  handler_type,
  handler_config,
  requires_approval_default,
  is_outbound,
  workspace_scope
)
values (
  'generate_image',
  'Generate an image using Recraft based on a text prompt. Optionally takes a Recraft style_id to apply a trained brand style.',
  jsonb_build_object(
    'type', 'object',
    'properties', jsonb_build_object(
      'prompt', jsonb_build_object('type', 'string', 'description', 'The image prompt.'),
      'style_id', jsonb_build_object('type', 'string', 'description', 'Optional Recraft trained brand-style UUID.'),
      'size', jsonb_build_object(
        'type', 'string',
        'description', 'Image size. Defaults to 1024x1024.',
        'enum', array['1024x1024', '1365x1024', '1024x1365', '1536x1024', '1024x1536']
      )
    ),
    'required', array['prompt']
  ),
  'internal',
  '{}'::jsonb,
  false,
  false,
  array['*']::text[]
)
on conflict (name) do nothing;
