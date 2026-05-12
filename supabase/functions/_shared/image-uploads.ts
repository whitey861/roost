// Roost: shared image-upload helpers (Deno copy for Edge Functions).
//
// Paired with shared/image-uploads.ts (Node, used by Vitest). Business
// logic between SHARED_RUNTIME_START / SHARED_RUNTIME_END must stay
// byte-equivalent (modulo comments and whitespace) to the Node copy.
// Run `npm run check:parity` to verify.

import type { AnthropicMessageContent } from './anthropic.ts';

// SHARED_RUNTIME_START

export const ANTHROPIC_IMAGE_MAX_BYTES = 5 * 1024 * 1024;

export const IMAGE_WITHOUT_CAPTION_PROMPT =
  'The user sent this image. Look at it and respond appropriately for this workspace.';

export function buildUserMessageContent(
  text: string,
  image: ImageUploadResult | null,
): string | AnthropicMessageContent[] {
  if (!image) return text;
  const blocks: AnthropicMessageContent[] = [
    { type: 'image', source: { type: 'url', url: image.url } },
  ];
  const caption = text.trim();
  if (caption.length > 0) {
    blocks.push({ type: 'text', text: caption });
  } else {
    blocks.push({ type: 'text', text: IMAGE_WITHOUT_CAPTION_PROMPT });
  }
  return blocks;
}

const EXT_TO_MIME: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
};

const SUPPORTED_MIME_TYPES = new Set(Object.values(EXT_TO_MIME));

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

export interface TelegramMessageWithMedia {
  photo?: TelegramPhotoSize[];
  document?: TelegramDocument;
  caption?: string;
  text?: string;
}

export interface ExtractedImageRef {
  fileId: string;
  fileSize: number | null;
  mimeHint: string | null;
  source: 'photo' | 'document';
}

export function extractImageRefFromTelegramMessage(
  msg: TelegramMessageWithMedia,
): ExtractedImageRef | null {
  if (Array.isArray(msg.photo) && msg.photo.length > 0) {
    const largest = msg.photo.reduce((a, b) => {
      const sa = a.file_size ?? (a.width ?? 0) * (a.height ?? 0);
      const sb = b.file_size ?? (b.width ?? 0) * (b.height ?? 0);
      return sb > sa ? b : a;
    });
    return {
      fileId: largest.file_id,
      fileSize: largest.file_size ?? null,
      mimeHint: null,
      source: 'photo',
    };
  }
  if (msg.document && typeof msg.document.mime_type === 'string'
      && msg.document.mime_type.startsWith('image/')) {
    return {
      fileId: msg.document.file_id,
      fileSize: msg.document.file_size ?? null,
      mimeHint: msg.document.mime_type,
      source: 'document',
    };
  }
  return null;
}

export interface DownloadedTelegramFile {
  bytes: Uint8Array;
  mime_type: string;
  ext: string;
}

export async function downloadTelegramFile(
  fileId: string,
  botToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<DownloadedTelegramFile> {
  const getFileResp = await fetchImpl(
    `https://api.telegram.org/bot${botToken}/getFile?file_id=${encodeURIComponent(fileId)}`,
  );
  if (!getFileResp.ok) {
    throw new Error(`Telegram getFile failed: ${getFileResp.status}`);
  }
  const body = await getFileResp.json() as { ok?: boolean; result?: { file_path?: string } };
  const filePath = body.result?.file_path;
  if (!filePath) {
    throw new Error('Telegram getFile returned no file_path');
  }

  const fileResp = await fetchImpl(
    `https://api.telegram.org/file/bot${botToken}/${filePath}`,
  );
  if (!fileResp.ok) {
    throw new Error(`Telegram file download failed: ${fileResp.status}`);
  }
  const bytes = new Uint8Array(await fileResp.arrayBuffer());

  const ext = (filePath.split('.').pop() ?? 'jpg').toLowerCase();
  const mime_type = EXT_TO_MIME[ext] ?? 'application/octet-stream';
  return { bytes, mime_type, ext };
}

export interface ImageUploadResult {
  url: string;
  mime_type: string;
  byte_size: number;
  source_file_id: string;
}

export async function uploadToSupabaseStorage(
  bytes: Uint8Array,
  mimeType: string,
  ext: string,
  supabaseUrl: string,
  serviceRoleKey: string,
  conversationId: string,
  fetchImpl: typeof fetch = fetch,
  uuid: () => string = () => crypto.randomUUID(),
): Promise<string> {
  const objectName = `${conversationId}/${uuid()}.${ext}`;
  const resp = await fetchImpl(
    `${supabaseUrl}/storage/v1/object/chat-uploads/${objectName}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${serviceRoleKey}`,
        'Content-Type': mimeType,
      },
      body: bytes as unknown as BodyInit,
    },
  );
  if (!resp.ok) {
    const detail = await resp.text().catch(() => '');
    throw new Error(`Storage upload failed: ${resp.status} ${detail}`);
  }
  return `${supabaseUrl}/storage/v1/object/public/chat-uploads/${objectName}`;
}

export interface IngestTelegramImageDeps {
  botToken: string;
  supabaseUrl: string;
  serviceRoleKey: string;
  conversationId: string;
  fetchImpl?: typeof fetch;
  uuid?: () => string;
}

export async function ingestTelegramImage(
  ref: ExtractedImageRef,
  deps: IngestTelegramImageDeps,
): Promise<ImageUploadResult> {
  if (ref.fileSize !== null && ref.fileSize > ANTHROPIC_IMAGE_MAX_BYTES) {
    throw new Error(
      `Image too large: ${ref.fileSize} bytes exceeds the ${ANTHROPIC_IMAGE_MAX_BYTES}-byte limit.`,
    );
  }
  const fetchImpl = deps.fetchImpl ?? fetch;
  const uuid = deps.uuid ?? (() => crypto.randomUUID());
  const downloaded = await downloadTelegramFile(ref.fileId, deps.botToken, fetchImpl);
  if (downloaded.bytes.byteLength > ANTHROPIC_IMAGE_MAX_BYTES) {
    throw new Error(
      `Image too large: ${downloaded.bytes.byteLength} bytes exceeds the ${ANTHROPIC_IMAGE_MAX_BYTES}-byte limit.`,
    );
  }
  let mime_type = downloaded.mime_type;
  if (!SUPPORTED_MIME_TYPES.has(mime_type) && ref.mimeHint && SUPPORTED_MIME_TYPES.has(ref.mimeHint)) {
    mime_type = ref.mimeHint;
  }
  if (!SUPPORTED_MIME_TYPES.has(mime_type)) {
    throw new Error(`Unsupported image mime type: ${mime_type}`);
  }
  const url = await uploadToSupabaseStorage(
    downloaded.bytes,
    mime_type,
    downloaded.ext,
    deps.supabaseUrl,
    deps.serviceRoleKey,
    deps.conversationId,
    fetchImpl,
    uuid,
  );
  return {
    url,
    mime_type,
    byte_size: downloaded.bytes.byteLength,
    source_file_id: ref.fileId,
  };
}

// SHARED_RUNTIME_END
