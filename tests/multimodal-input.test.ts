// Roost Phase 8: multimodal user input tests.
// Covers the four layers that change for image-bearing Telegram messages:
//   1. Detection — pulling the right file_id out of a Telegram update.
//   2. Download — the two-step getFile + CDN flow against a fake fetch.
//   3. Storage upload — POSTing bytes to Supabase Storage and returning a
//      public URL with the chat-uploads bucket prefix.
//   4. Runtime pass-through — runChat accepting an AnthropicMessageContent[]
//      array, persisting it as jsonb, and reconstructing history without
//      loss on subsequent turns.

import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  ANTHROPIC_IMAGE_BYTE_LIMIT,
  DEFAULT_IMAGE_PROMPT,
  buildMultimodalUserContent,
  downloadTelegramFile,
  extractImageFromTelegramMessage,
  uploadToSupabaseStorage,
} from '../shared/image-uploads.js';
import { runChat, reconstructHistory } from '../shared/chat-runtime.js';
import type { AnthropicMessageContent } from '../shared/anthropic.js';
import type { ChatStreamEvent } from '../shared/types.js';
import { FakeAnthropic } from './fakes/fake-anthropic.js';
import { FakeSupabaseClient } from './fakes/fake-supabase.js';
import { fakeQueryEmbedder } from './fakes/fake-embedder.js';
import { seedFakeDb } from './fixtures/seed-fake-db.js';

async function collect(it: AsyncIterable<ChatStreamEvent>): Promise<ChatStreamEvent[]> {
  const out: ChatStreamEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

function client(db: ReturnType<typeof seedFakeDb>['db']): SupabaseClient {
  return new FakeSupabaseClient(db) as unknown as SupabaseClient;
}

describe('extractImageFromTelegramMessage', () => {
  it('returns the largest photo size when message.photo is present', () => {
    const result = extractImageFromTelegramMessage({
      photo: [
        { file_id: 'small', file_unique_id: 'a1', width: 90, height: 67, file_size: 1234 },
        { file_id: 'medium', file_unique_id: 'a2', width: 320, height: 240, file_size: 12345 },
        { file_id: 'large', file_unique_id: 'a3', width: 1280, height: 960, file_size: 234567 },
      ],
    });
    expect(result).toEqual({ file_id: 'large', file_size: 234567, source: 'photo' });
  });

  it('returns the document file_id when mime_type is image/*', () => {
    const result = extractImageFromTelegramMessage({
      document: { file_id: 'doc1', mime_type: 'image/png', file_name: 'screenshot.png', file_size: 50000 },
    });
    expect(result).toEqual({ file_id: 'doc1', file_size: 50000, source: 'document' });
  });

  it('ignores non-image documents (PDF, etc.)', () => {
    const result = extractImageFromTelegramMessage({
      document: { file_id: 'pdf1', mime_type: 'application/pdf', file_name: 'report.pdf', file_size: 50000 },
    });
    expect(result).toBeNull();
  });

  it('returns null when neither photo nor an image document is present', () => {
    expect(extractImageFromTelegramMessage({})).toBeNull();
    expect(extractImageFromTelegramMessage({ photo: [] })).toBeNull();
  });

  it('prefers photo over document when both are present', () => {
    const result = extractImageFromTelegramMessage({
      photo: [{ file_id: 'photo1', width: 100, height: 100 }],
      document: { file_id: 'doc1', mime_type: 'image/png' },
    });
    expect(result?.file_id).toBe('photo1');
  });

  it('exposes a null file_size when Telegram omits it', () => {
    const result = extractImageFromTelegramMessage({
      photo: [{ file_id: 'photo1', width: 10, height: 10 }],
    });
    expect(result?.file_size).toBeNull();
  });
});

function makeFetch(
  responder: (url: string, init?: RequestInit) => { ok: boolean; status?: number; json?: unknown; bytes?: Uint8Array; text?: string },
): { fetch: typeof fetch; calls: Array<{ url: string; init: RequestInit | undefined }> } {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fn: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
    calls.push({ url, init });
    const r = responder(url, init);
    const bytes = r.bytes ?? new Uint8Array();
    return {
      ok: r.ok,
      status: r.status ?? (r.ok ? 200 : 500),
      json: async () => (r.json ?? {}) as unknown,
      text: async () => r.text ?? '',
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    } as unknown as Response;
  };
  return { fetch: fn, calls };
}

describe('downloadTelegramFile', () => {
  it('resolves file_path via getFile and downloads bytes from the CDN', async () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const { fetch, calls } = makeFetch((url) => {
      if (url.includes('/getFile')) {
        return { ok: true, json: { result: { file_path: 'photos/file_42.png' } } };
      }
      if (url.includes('/file/bot')) {
        return { ok: true, bytes };
      }
      return { ok: false, status: 404 };
    });

    const result = await downloadTelegramFile('FILE_ID_123', 'fake-token', fetch);

    expect(calls).toHaveLength(2);
    expect(calls[0]?.url).toContain('/getFile?file_id=FILE_ID_123');
    expect(calls[1]?.url).toContain('/file/botfake-token/photos/file_42.png');
    expect(result.bytes).toEqual(bytes);
    expect(result.mime_type).toBe('image/png');
    expect(result.ext).toBe('png');
  });

  it('infers image/jpeg from a .jpg path', async () => {
    const { fetch } = makeFetch((url) => {
      if (url.includes('/getFile')) return { ok: true, json: { result: { file_path: 'photos/x.jpg' } } };
      return { ok: true, bytes: new Uint8Array([0xff, 0xd8]) };
    });
    const result = await downloadTelegramFile('id', 't', fetch);
    expect(result.mime_type).toBe('image/jpeg');
    expect(result.ext).toBe('jpg');
  });

  it('throws with status when getFile fails (404)', async () => {
    const { fetch } = makeFetch(() => ({ ok: false, status: 404 }));
    await expect(downloadTelegramFile('missing', 't', fetch)).rejects.toThrow(/getFile failed: 404/);
  });

  it('throws when getFile returns no file_path', async () => {
    const { fetch } = makeFetch(() => ({ ok: true, json: { result: {} } }));
    await expect(downloadTelegramFile('x', 't', fetch)).rejects.toThrow(/no file_path/);
  });

  it('throws when the CDN download fails', async () => {
    const { fetch } = makeFetch((url) => {
      if (url.includes('/getFile')) return { ok: true, json: { result: { file_path: 'a.png' } } };
      return { ok: false, status: 500 };
    });
    await expect(downloadTelegramFile('x', 't', fetch)).rejects.toThrow(/file download failed: 500/);
  });
});

describe('uploadToSupabaseStorage', () => {
  it('POSTs bytes to the chat-uploads bucket and returns the public URL', async () => {
    const { fetch, calls } = makeFetch(() => ({ ok: true, status: 200 }));
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const url = await uploadToSupabaseStorage(
      bytes,
      'image/png',
      'png',
      'https://proj.supabase.co',
      'service-role-key',
      'conv-abc',
      { fetchImpl: fetch, uuid: () => 'fixed-uuid' },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://proj.supabase.co/storage/v1/object/chat-uploads/conv-abc/fixed-uuid.png');
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer service-role-key');
    expect(headers['Content-Type']).toBe('image/png');
    expect(url).toBe('https://proj.supabase.co/storage/v1/object/public/chat-uploads/conv-abc/fixed-uuid.png');
  });

  it('throws when Supabase Storage rejects the upload', async () => {
    const { fetch } = makeFetch(() => ({ ok: false, status: 400, text: 'bad mime' }));
    await expect(
      uploadToSupabaseStorage(
        new Uint8Array([1]),
        'application/octet-stream',
        'bin',
        'https://p.supabase.co',
        'k',
        'conv',
        { fetchImpl: fetch, uuid: () => 'u' },
      ),
    ).rejects.toThrow(/Storage upload failed: 400 bad mime/);
  });

  it('uses conversation_id as the folder prefix', async () => {
    const { fetch, calls } = makeFetch(() => ({ ok: true }));
    await uploadToSupabaseStorage(
      new Uint8Array([0]),
      'image/png',
      'png',
      'https://p.supabase.co',
      'k',
      'conversation-xyz',
      { fetchImpl: fetch, uuid: () => 'u' },
    );
    expect(calls[0]?.url).toContain('/chat-uploads/conversation-xyz/u.png');
  });

  it('strips a trailing slash from supabaseUrl', async () => {
    const { fetch, calls } = makeFetch(() => ({ ok: true }));
    const url = await uploadToSupabaseStorage(
      new Uint8Array([0]),
      'image/png',
      'png',
      'https://p.supabase.co/',
      'k',
      'c',
      { fetchImpl: fetch, uuid: () => 'u' },
    );
    expect(calls[0]?.url).toBe('https://p.supabase.co/storage/v1/object/chat-uploads/c/u.png');
    expect(url).toBe('https://p.supabase.co/storage/v1/object/public/chat-uploads/c/u.png');
  });
});

describe('buildMultimodalUserContent', () => {
  it('returns just the caption string when no image is provided', () => {
    expect(buildMultimodalUserContent({ caption: 'hello' })).toBe('hello');
    expect(buildMultimodalUserContent({ caption: '  trimmed  ' })).toBe('trimmed');
  });

  it('builds an image + caption two-block array when both are present', () => {
    const result = buildMultimodalUserContent({
      imageUrl: 'https://example.com/a.png',
      caption: 'what is this?',
    });
    expect(result).toEqual([
      { type: 'image', source: { type: 'url', url: 'https://example.com/a.png' } },
      { type: 'text', text: 'what is this?' },
    ]);
  });

  it('falls back to the default prompt when an image has no caption', () => {
    const result = buildMultimodalUserContent({ imageUrl: 'https://example.com/a.png' });
    expect(result).toEqual([
      { type: 'image', source: { type: 'url', url: 'https://example.com/a.png' } },
      { type: 'text', text: DEFAULT_IMAGE_PROMPT },
    ]);
  });

  it('supports an explicit defaultPrompt override', () => {
    const result = buildMultimodalUserContent({
      imageUrl: 'https://example.com/a.png',
      defaultPrompt: 'Describe this Oar Fish hoodie sketch.',
    });
    const blocks = result as Array<{ type: string; text?: string }>;
    expect(blocks[1]?.text).toBe('Describe this Oar Fish hoodie sketch.');
  });

  it('exposes the Anthropic 5MB cap for callers', () => {
    expect(ANTHROPIC_IMAGE_BYTE_LIMIT).toBe(5 * 1024 * 1024);
  });
});

describe('runChat: multimodal user message pass-through', () => {
  it('forwards an image+text content array to Anthropic and persists it as jsonb', async () => {
    const fx = seedFakeDb();
    const anthropic = new FakeAnthropic([
      { text: 'It looks like a sketch.', stopReason: 'end_turn', inputTokens: 50, outputTokens: 6 },
    ]);

    const userContent: AnthropicMessageContent[] = [
      { type: 'image', source: { type: 'url', url: 'https://p.supabase.co/storage/v1/object/public/chat-uploads/abc/img.png' } },
      { type: 'text', text: 'What is this?' },
    ];

    const events = await collect(runChat({
      client: client(fx.db),
      anthropic,
      workspaceId: fx.workspaceId,
      userId: fx.userId,
      channel: 'telegram',
      userMessage: userContent,
      embedQueryFn: fakeQueryEmbedder,
    }));

    // Anthropic received the array content unchanged on the first message.
    expect(anthropic.calls).toHaveLength(1);
    const sentMessages = anthropic.calls[0]!.messages;
    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0]?.role).toBe('user');
    expect(sentMessages[0]?.content).toEqual(userContent);

    // The user message is persisted with the content array intact (jsonb).
    const messages = fx.db.tableRows('messages');
    const userRow = messages.find((m) => m.role === 'user');
    expect(userRow?.content).toEqual(userContent);

    // Stream still streams the assistant text out normally.
    const finalText = events.filter((e) => e.type === 'token').map((e) => (e as { text: string }).text).join('');
    expect(finalText).toBe('It looks like a sketch.');
  });

  it('persists a text-only user message as a plain string for backwards compat', async () => {
    const fx = seedFakeDb();
    const anthropic = new FakeAnthropic([
      { text: 'ok.', stopReason: 'end_turn', inputTokens: 1, outputTokens: 1 },
    ]);
    await collect(runChat({
      client: client(fx.db),
      anthropic,
      workspaceId: fx.workspaceId,
      userId: fx.userId,
      channel: 'web',
      userMessage: 'hello',
      embedQueryFn: fakeQueryEmbedder,
    }));
    const userRow = fx.db.tableRows('messages').find((m) => m.role === 'user');
    expect(userRow?.content).toBe('hello');
  });

  it('reconstructs a multimodal user message on the next turn without loss', async () => {
    const fx = seedFakeDb();
    const userContent: AnthropicMessageContent[] = [
      { type: 'image', source: { type: 'url', url: 'https://p.supabase.co/storage/v1/object/public/chat-uploads/x/y.png' } },
      { type: 'text', text: 'Describe this.' },
    ];

    // First turn: send the image.
    const a1 = new FakeAnthropic([
      { text: 'A blue square.', stopReason: 'end_turn', inputTokens: 20, outputTokens: 5 },
    ]);
    const ev1 = await collect(runChat({
      client: client(fx.db),
      anthropic: a1,
      workspaceId: fx.workspaceId,
      userId: fx.userId,
      channel: 'telegram',
      userMessage: userContent,
      embedQueryFn: fakeQueryEmbedder,
    }));
    const sessionId = (ev1.find((e) => e.type === 'session') as { session_id: string }).session_id;

    // Second turn: follow-up text. History must include the image as a
    // proper image block, not a stringified JSON dump.
    const a2 = new FakeAnthropic([
      { text: 'Yes, blue.', stopReason: 'end_turn', inputTokens: 30, outputTokens: 3 },
    ]);
    await collect(runChat({
      client: client(fx.db),
      anthropic: a2,
      workspaceId: fx.workspaceId,
      userId: fx.userId,
      channel: 'telegram',
      sessionId,
      userMessage: 'Is it blue?',
      embedQueryFn: fakeQueryEmbedder,
    }));

    const messagesSent = a2.calls[0]!.messages;
    // [user image+text, assistant 'A blue square.', user 'Is it blue?']
    expect(messagesSent.length).toBeGreaterThanOrEqual(3);
    const firstUser = messagesSent[0]!;
    expect(firstUser.role).toBe('user');
    expect(firstUser.content).toEqual(userContent);
  });

  it('reconstructHistory normalises a string user row and an array user row', () => {
    const rows = [
      {
        role: 'user',
        content: 'plain text',
        tool_call_id: null,
        tool_name: null,
        tool_input: null,
        tool_output: null,
      },
      {
        role: 'assistant',
        content: 'sure',
        tool_call_id: null,
        tool_name: null,
        tool_input: null,
        tool_output: null,
      },
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'url', url: 'https://example.com/a.png' } },
          { type: 'text', text: 'and this?' },
        ],
        tool_call_id: null,
        tool_name: null,
        tool_input: null,
        tool_output: null,
      },
    ];
    const messages = reconstructHistory(rows);
    expect(messages).toHaveLength(3);
    expect(messages[0]).toEqual({ role: 'user', content: 'plain text' });
    expect(messages[2]?.role).toBe('user');
    expect(messages[2]?.content).toEqual([
      { type: 'image', source: { type: 'url', url: 'https://example.com/a.png' } },
      { type: 'text', text: 'and this?' },
    ]);
  });
});

describe('messages.content jsonb migration', () => {
  it('migration 0015 alters content to jsonb idempotently', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const file = path.join(__dirname, '..', 'supabase', 'migrations', '0015_messages_content_jsonb.sql');
    const sql = fs.readFileSync(file, 'utf8');
    expect(sql).toMatch(/alter column content type jsonb/i);
    expect(sql).toMatch(/using to_jsonb\(content\)/i);
    // Guard so re-running the migration is a no-op after the first run.
    expect(sql).toMatch(/information_schema\.columns/);
  });

  it('migration 0016 creates the chat-uploads bucket idempotently', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const file = path.join(__dirname, '..', 'supabase', 'migrations', '0016_chat_uploads_bucket.sql');
    const sql = fs.readFileSync(file, 'utf8');
    expect(sql).toContain("'chat-uploads'");
    expect(sql).toMatch(/on conflict \(id\) do nothing/i);
    expect(sql).toContain('image/png');
    expect(sql).toContain('image/jpeg');
  });
});
