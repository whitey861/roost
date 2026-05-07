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

// Pure 6-digit code generator. Uses crypto.getRandomValues which is
// available in Node 19+ and Deno.
export function generatePairingCode(): string {
  const buf = new Uint8Array(4);
  crypto.getRandomValues(buf);
  const n = ((buf[0]! << 24) | (buf[1]! << 16) | (buf[2]! << 8) | buf[3]!) >>> 0;
  return String(n % 1_000_000).padStart(6, '0');
}
