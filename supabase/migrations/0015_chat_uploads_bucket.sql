-- Roost: chat-uploads Storage bucket.
--
-- Phase 8 (multimodal input): images that users send to the Telegram bot get
-- persisted here, then referenced by URL in the multimodal user message we
-- pass to Anthropic. Public bucket because Anthropic's `source.type='url'`
-- fetches images without authentication; object names use UUIDs and a
-- conversation-id prefix so URLs are non-guessable in practice.
--
-- Idempotent: `on conflict (id) do nothing` skips on re-run.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'chat-uploads',
  'chat-uploads',
  true,
  10485760,
  array['image/png', 'image/jpeg', 'image/webp', 'image/gif']
)
on conflict (id) do nothing;
