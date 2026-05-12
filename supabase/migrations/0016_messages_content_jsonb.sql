-- Roost: migrate messages.content from text to jsonb to support multimodal
-- user message content (an array of {type:'text'|'image', ...} blocks) in
-- addition to plain strings.
--
-- Existing text rows become JSON strings so reads can keep handling either
-- shape via the content normaliser in the chat runtime.

alter table public.messages
  alter column content type jsonb using to_jsonb(content);
