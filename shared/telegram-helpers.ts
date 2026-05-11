// Roost: pure helpers for Telegram update handling. Tested directly.

export interface ParsedSlash {
  command: string;
  arg: string | null;
}

export function parseSlashCommand(text: string): ParsedSlash | null {
  if (!text.startsWith('/')) return null;
  const trimmed = text.slice(1);
  const sp = trimmed.indexOf(' ');
  if (sp === -1) return { command: trimmed.toLowerCase(), arg: null };
  return {
    command: trimmed.slice(0, sp).toLowerCase(),
    arg: trimmed.slice(sp + 1).trim() || null,
  };
}

export type ApprovalCallbackOp = 'approve' | 'reject' | 'preview' | 'edit';

export interface ParsedCallback {
  op: ApprovalCallbackOp;
  actionId: string;
}

export function parseApprovalCallback(data: string): ParsedCallback | null {
  const parts = data.split(':');
  if (parts.length < 3 || parts[0] !== 'act') return null;
  const op = parts[1];
  if (op !== 'approve' && op !== 'reject' && op !== 'preview' && op !== 'edit') return null;
  const actionId = parts.slice(2).join(':');
  if (!actionId) return null;
  return { op, actionId };
}

export interface SpawnArgs {
  repo: string;
  maxRuntimeMinutes: number;
  maxCostUsd: number;
}

export interface SpawnArgsError {
  error: string;
}

// Parses the argument of `/spawn <owner/repo> [<minutes>] [<cost_usd>]`.
// /spawn is the structural escape hatch from the chat agent hallucinating
// spawn_dev_agent tool calls on long, multi-message specs: it bypasses the
// model and lets the webhook insert a dev_jobs row directly. Defaults match
// the spawn_dev_agent tool (120 min, $5). Caps: 720 min, $100.
export function parseSpawnArgs(arg: string | null): SpawnArgs | SpawnArgsError {
  const usage = 'Usage: /spawn <owner/repo> [<minutes>] [<cost_usd>]';
  if (!arg || arg.trim().length === 0) return { error: usage };
  const parts = arg.trim().split(/\s+/);
  if (parts.length > 3) return { error: `Too many arguments. ${usage}` };

  const repo = parts[0]!;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
    return { error: `Repo must be in owner/name form. Got: ${repo}` };
  }

  let maxRuntimeMinutes = 120;
  if (parts.length >= 2) {
    const raw = parts[1]!;
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n) || String(n) !== raw || n < 1 || n > 720) {
      return { error: 'Minutes must be an integer between 1 and 720.' };
    }
    maxRuntimeMinutes = n;
  }

  let maxCostUsd = 5.0;
  if (parts.length >= 3) {
    const c = Number.parseFloat(parts[2]!);
    if (!Number.isFinite(c) || c < 0.01 || c > 100) {
      return { error: 'Cost must be a number between 0.01 and 100.' };
    }
    maxCostUsd = c;
  }

  return { repo, maxRuntimeMinutes, maxCostUsd };
}

// Telegram caption hard limit (chars). Captions over this length must be
// sent as a separate text message after the photo.
export const TELEGRAM_CAPTION_LIMIT = 1024;

// Matches the first markdown image with a recognised image-file extension.
// Conservative on purpose: only HTTPS URLs ending in a known image
// extension, so we don't try to send an arbitrary link as a photo.
const IMAGE_MARKDOWN_RE = /!\[([^\]]*)\]\((https?:\/\/[^)\s]+\.(?:png|jpg|jpeg|gif|webp))\)/i;

export interface ExtractedImage {
  imageUrl: string;
  alt: string;
  // Caption is the assistant text with the image markdown removed,
  // already trimmed. Use `alt` as a fallback when this is empty.
  caption: string;
  // True when the caption is too long for Telegram and must be sent
  // as a follow-up text message after sendPhoto.
  captionOverflow: boolean;
}

export function extractFirstImageMarkdown(text: string): ExtractedImage | null {
  const match = text.match(IMAGE_MARKDOWN_RE);
  if (!match) return null;
  const [fullMatch, alt, imageUrl] = match;
  const stripped = text.replace(fullMatch!, '').trim();
  const captionOverflow = stripped.length > TELEGRAM_CAPTION_LIMIT;
  return {
    imageUrl: imageUrl!,
    alt: alt ?? '',
    caption: stripped,
    captionOverflow,
  };
}

// Pure 6-digit code generator. Uses crypto.getRandomValues which is
// available in Node 19+ and Deno.
export function generatePairingCode(): string {
  const buf = new Uint8Array(4);
  crypto.getRandomValues(buf);
  const n = ((buf[0]! << 24) | (buf[1]! << 16) | (buf[2]! << 8) | buf[3]!) >>> 0;
  return String(n % 1_000_000).padStart(6, '0');
}
