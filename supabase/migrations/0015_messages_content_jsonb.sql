-- Roost: widen messages.content from text to jsonb so a single user row can
-- carry a content-block array (text + image) for multimodal input.
--
-- Existing rows are converted with to_jsonb(): a non-NULL text value becomes
-- a JSON string, which Supabase reads back as a JS string — preserving the
-- read shape the runtime already expects for text-only messages. New
-- multimodal user messages are persisted as JSON arrays of content blocks.
--
-- Idempotent: only runs the ALTER when the column is still text.
do $$
begin
  if (
    select data_type
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'messages'
      and column_name = 'content'
  ) = 'text' then
    alter table public.messages
      alter column content type jsonb
      using to_jsonb(content);
  end if;
end
$$;
