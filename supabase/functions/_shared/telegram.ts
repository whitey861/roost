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
