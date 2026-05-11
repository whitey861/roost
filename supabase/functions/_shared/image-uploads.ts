// Roost: helpers for accepting user-uploaded images over Telegram and
// staging them in Supabase Storage so Anthropic can fetch them as image
// URL sources on subsequent turns.
//
// Paired with shared/image-uploads.ts (Node copy used by Vitest). Keep
// in sync — no parity script enforces this because the file has no
// SHARED_RUNTIME markers, but the multimodal-input tests exercise both
// copies through their respective callers.

// Anthropic image inputs are capped at 5MB per file. Telegram allows up
// to 20MB, but anything above this cap is rejected before upload to avoid
// burning storage on files we can't actually send to the model.
export const ANTHROPIC_IMAGE_BYTE_LIMIT = 5 * 1024 * 1024;

// Default prompt injected when the user sends an image with no caption,
// so the agent always has at least one text block to react to.
export const DEFAULT_IMAGE_PROMPT =
  'The user sent this image. Look at it and respond appropriately for this workspace.';

const EXT_TO_MIME: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
};

export interface TelegramPhotoSize {
  file_id: string;
  file_unique_id?: string;
  width?: number;
  height?: number;
  file_size?: number;
}

export interface TelegramDocument {
  file_id: string;
  file_unique_id?: string;
  mime_type?: string;
  file_name?: string;
  file_size?: number;
}

export interface TelegramImageMessageShape {
  photo?: TelegramPhotoSize[];
  document?: TelegramDocument;
}

export interface ExtractedImage {
  file_id: string;
  file_size: number | null;
  source: 'photo' | 'document';
}

// Pulls out the right file_id when a Telegram message contains an image.
// Photo: pick the largest size (last entry).
// Document: only if mime_type starts with image/.
// Anything else (including non-image documents): null.
export function extractImageFromTelegramMessage(
  message: TelegramImageMessageShape,
): ExtractedImage | null {
  if (Array.isArray(message.photo) && message.photo.length > 0) {
    const largest = message.photo[message.photo.length - 1]!;
    return {
      file_id: largest.file_id,
      file_size: typeof largest.file_size === 'number' ? largest.file_size : null,
      source: 'photo',
    };
  }
  const doc = message.document;
  if (doc && typeof doc.mime_type === 'string' && doc.mime_type.startsWith('image/')) {
    return {
      file_id: doc.file_id,
      file_size: typeof doc.file_size === 'number' ? doc.file_size : null,
      source: 'document',
    };
  }
  return null;
}

export interface TelegramFileBytes {
  bytes: Uint8Array;
  mime_type: string;
  ext: string;
}

// Two-step Telegram download: getFile to resolve the file path, then a
// CDN fetch for the bytes themselves. fetchImpl is injectable for tests.
export async function downloadTelegramFile(
  fileId: string,
  botToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<TelegramFileBytes> {
  const getFileUrl = `https://api.telegram.org/bot${botToken}/getFile?file_id=${encodeURIComponent(fileId)}`;
  const getFileResp = await fetchImpl(getFileUrl);
  if (!getFileResp.ok) {
    throw new Error(`Telegram getFile failed: ${getFileResp.status}`);
  }
  const parsed = (await getFileResp.json()) as { result?: { file_path?: string } };
  const filePath = parsed.result?.file_path;
  if (typeof filePath !== 'string' || filePath.length === 0) {
    throw new Error('Telegram getFile returned no file_path');
  }

  const fileUrl = `https://api.telegram.org/file/bot${botToken}/${filePath}`;
  const fileResp = await fetchImpl(fileUrl);
  if (!fileResp.ok) {
    throw new Error(`Telegram file download failed: ${fileResp.status}`);
  }
  const bytes = new Uint8Array(await fileResp.arrayBuffer());
  const ext = (filePath.split('.').pop() ?? 'jpg').toLowerCase();
  const mime_type = EXT_TO_MIME[ext] ?? 'application/octet-stream';
  return { bytes, mime_type, ext };
}

export interface StorageUploadOptions {
  fetchImpl?: typeof fetch;
  uuid?: () => string;
}

// Uploads to the public chat-uploads bucket via Supabase Storage's REST API
// and returns the public URL. conversationId is used as a folder prefix so
// every user's uploads stay grouped and traceable.
export async function uploadToSupabaseStorage(
  bytes: Uint8Array,
  mimeType: string,
  ext: string,
  supabaseUrl: string,
  serviceRoleKey: string,
  conversationId: string,
  options: StorageUploadOptions = {},
): Promise<string> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const uuid = options.uuid ?? (() => crypto.randomUUID());
  const base = supabaseUrl.replace(/\/+$/, '');
  const objectName = `${conversationId}/${uuid()}.${ext}`;
  const uploadUrl = `${base}/storage/v1/object/chat-uploads/${objectName}`;

  // Cast through ArrayBufferView — Uint8Array satisfies BodyInit in Node 22
  // and Deno but the TS lib types disagree.
  const body = bytes as unknown as BodyInit;
  const resp = await fetchImpl(uploadUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${serviceRoleKey}`,
      'Content-Type': mimeType,
    },
    body,
  });
  if (!resp.ok) {
    const txt = await resp.text().catch(() => '');
    throw new Error(`Storage upload failed: ${resp.status} ${txt}`);
  }
  return `${base}/storage/v1/object/public/chat-uploads/${objectName}`;
}

export interface ImageUploadResult {
  url: string;
  mime_type: string;
  byte_size: number;
  source_file_id: string;
}

export interface UserContentBlock {
  type: 'image' | 'text';
}

export type ImageContentBlock = { type: 'image'; source: { type: 'url'; url: string } };
export type TextContentBlock = { type: 'text'; text: string };
export type MultimodalUserContent = string | Array<ImageContentBlock | TextContentBlock>;

export interface BuildUserContentInput {
  imageUrl?: string | null;
  caption?: string | null;
  defaultPrompt?: string;
}

// Compose the user message that the runtime sends to Anthropic. The image
// block always goes first so the model sees the visual context before any
// caption. When the user sends a bare image we inject a default prompt so
// every assistant turn has at least one text input to react to.
export function buildMultimodalUserContent(input: BuildUserContentInput): MultimodalUserContent {
  const caption = (input.caption ?? '').trim();
  if (!input.imageUrl) {
    return caption;
  }
  const blocks: Array<ImageContentBlock | TextContentBlock> = [
    { type: 'image', source: { type: 'url', url: input.imageUrl } },
  ];
  if (caption.length > 0) {
    blocks.push({ type: 'text', text: caption });
  } else {
    blocks.push({ type: 'text', text: input.defaultPrompt ?? DEFAULT_IMAGE_PROMPT });
  }
  return blocks;
}
