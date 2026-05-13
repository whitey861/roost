// Roost: Telegram Bot API client (raw fetch).
// Just enough surface to send and edit messages, send approval keyboards,
// and answer callback queries. No SDK.

import { env } from './env.ts';

const API_BASE = 'https://api.telegram.org';

export interface InlineKeyboardButton {
  text: string;
  callback_data?: string;
  url?: string;
}

export interface InlineKeyboardMarkup {
  inline_keyboard: InlineKeyboardButton[][];
}

interface ApiResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
}

async function call<T>(method: string, params: Record<string, unknown>): Promise<T> {
  const token = env('TELEGRAM_BOT_TOKEN');
  const res = await fetch(`${API_BASE}/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  const json = (await res.json()) as ApiResponse<T>;
  if (!json.ok) {
    throw new Error(`Telegram ${method} failed: ${json.description ?? 'unknown'} (${json.error_code ?? '?'})`);
  }
  return json.result as T;
}

export interface SentMessage {
  message_id: number;
  chat: { id: number };
}

export function sendMessage(chatId: number, text: string, options: { reply_markup?: InlineKeyboardMarkup; parse_mode?: 'Markdown' | 'HTML'; disable_web_page_preview?: boolean } = {}): Promise<SentMessage> {
  return call<SentMessage>('sendMessage', {
    chat_id: chatId,
    text,
    ...options,
  });
}

export async function editMessageText(chatId: number, messageId: number, text: string, options: { reply_markup?: InlineKeyboardMarkup; parse_mode?: 'Markdown' | 'HTML' } = {}): Promise<void> {
  // Telegram throws "message is not modified" if the text is unchanged.
  // Catch and ignore that specific case.
  try {
    await call('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text,
      ...options,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('message is not modified')) return;
    throw err;
  }
}

export function answerCallbackQuery(callbackQueryId: string, text?: string): Promise<true> {
  return call<true>('answerCallbackQuery', {
    callback_query_id: callbackQueryId,
    text: text ?? '',
  });
}

// Telegram caption hard limit is 1024 characters.
export const TELEGRAM_CAPTION_LIMIT = 1024;

// Telegram per-message text hard limit is 4096; split below that for
// rendering-quirk headroom. Inline mirror of
// shared/telegram-helpers.ts#splitForTelegram (unit-tested there).
export const TELEGRAM_MESSAGE_LIMIT = 4096;
export const TELEGRAM_SPLIT_THRESHOLD = 3500;

export function splitForTelegram(text: string, maxChunkSize: number = TELEGRAM_SPLIT_THRESHOLD): string[] {
  if (text.length === 0) return [];
  if (text.length <= maxChunkSize) return [text];

  const chunks: string[] = [];
  let current = '';

  const flush = (): void => {
    if (current.length > 0) {
      chunks.push(current);
      current = '';
    }
  };

  const tryAppend = (piece: string, sep: string): boolean => {
    if (current.length === 0) {
      if (piece.length <= maxChunkSize) {
        current = piece;
        return true;
      }
      return false;
    }
    const next = current + sep + piece;
    if (next.length <= maxChunkSize) {
      current = next;
      return true;
    }
    return false;
  };

  const paragraphs = text.split(/\n\n+/);
  for (const para of paragraphs) {
    if (para.length === 0) continue;
    if (tryAppend(para, '\n\n')) continue;

    flush();
    if (para.length <= maxChunkSize) {
      current = para;
      continue;
    }

    const sentences = para.split(/(?<=[.!?])\s+/);
    for (const sent of sentences) {
      if (sent.length === 0) continue;
      if (tryAppend(sent, ' ')) continue;

      flush();
      if (sent.length <= maxChunkSize) {
        current = sent;
        continue;
      }

      let remainder = sent;
      while (remainder.length > maxChunkSize) {
        chunks.push(remainder.slice(0, maxChunkSize));
        remainder = remainder.slice(maxChunkSize);
      }
      if (remainder.length > 0) current = remainder;
    }
  }

  flush();
  return chunks;
}

// Edits the placeholder with the first chunk and sends remaining chunks
// as new messages. Used to fix truncation of replies longer than the
// 4096-char per-message limit.
export async function sendChunkedReply(
  chatId: number,
  placeholderMessageId: number,
  text: string,
  maxChunkSize: number = TELEGRAM_SPLIT_THRESHOLD,
): Promise<number> {
  const chunks = splitForTelegram(text, maxChunkSize);
  if (chunks.length === 0) {
    await editMessageText(chatId, placeholderMessageId, '(no reply)');
    return 1;
  }
  await editMessageText(chatId, placeholderMessageId, chunks[0]!);
  for (let i = 1; i < chunks.length; i++) {
    await sendMessage(chatId, chunks[i]!);
  }
  return chunks.length;
}

export function sendPhoto(
  chatId: number,
  photoUrl: string,
  options: { caption?: string; parse_mode?: 'Markdown' | 'HTML' } = {},
): Promise<SentMessage> {
  const params: Record<string, unknown> = { chat_id: chatId, photo: photoUrl };
  if (options.caption !== undefined) params.caption = options.caption;
  if (options.parse_mode !== undefined) params.parse_mode = options.parse_mode;
  return call<SentMessage>('sendPhoto', params);
}

export function setWebhook(url: string, secretToken: string): Promise<true> {
  return call<true>('setWebhook', {
    url,
    secret_token: secretToken,
    drop_pending_updates: true,
  });
}

export function getMe(): Promise<{ id: number; username: string; first_name: string }> {
  return call('getMe', {});
}
