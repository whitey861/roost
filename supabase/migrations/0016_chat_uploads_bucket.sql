-- Roost: public Supabase Storage bucket for user-uploaded chat images.
--
-- Public because Anthropic's image-block `source: { type: 'url' }` fetches
-- the file without auth headers. Object names embed a per-upload UUID, so
-- public URLs are effectively unguessable.
--
-- Limits: 10MB per object, image MIME types only. Telegram caps the
-- webhook download at 20MB but Anthropic's image API caps at 5MB; the
-- runtime enforces the tighter 5MB cap before upload.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'chat-uploads',
  'chat-uploads',
  true,
  10485760,
  array['image/png', 'image/jpeg', 'image/webp', 'image/gif']
)
on conflict (id) do nothing;
