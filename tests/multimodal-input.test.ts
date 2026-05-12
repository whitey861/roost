// Phase 8: multimodal user message input.
//
// Covers the shared image-uploads helper (Telegram parsing, download, upload)
// and the chat-runtime end-to-end with an image + text content array.

import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  extractImageRefFromTelegramMessage,
  downloadTelegramFile,
  uploadToSupabaseStorage,
  ingestTelegramImage,
  buildUserMessageContent,
  IMAGE_WITHOUT_CAPTION_PROMPT,
  ANTHROPIC_IMAGE_MAX_BYTES,
} from '../shared/image-uploads.js';
import {
  normaliseUserMessageContent,
  userMessageText,
  reconstructHistory,
  runChat,
} from '../shared/chat-runtime.js';
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

// Minimal fetch fake. Routes by URL substring; each route is a queue of
// scripted responses. Records every call for assertions.
class FetchFake {
  public calls: Array<{ url: string; init?: RequestInit }> = [];
  private routes = new Map<string, Array<() => Response>>();

  on(urlSubstring: string, response: () => Response): this {
    const existing = this.routes.get(urlSubstring) ?? [];
    existing.push(response);
    this.routes.set(urlSubstring, existing);
    return this;
  }

  fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    this.calls.push({ url, init });
    for (const [needle, queue] of this.routes) {
      if (url.includes(needle)) {
        const next = queue.shift();
        if (!next) throw new Error(`FetchFake: route exhausted for ${needle}`);
        return next();
      }
    }
    throw new Error(`FetchFake: no route for ${url}`);
  };
}

function ok(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}
function bytesResponse(bytes: Uint8Array): Response {
  return new Response(bytes as unknown as BodyInit, { status: 200 });
}

describe('extractImageRefFromTelegramMessage', () => {
  it('returns the largest photo size from a photo message', () => {
    const ref = extractImageRefFromTelegramMessage({
      photo: [
        { file_id: 'small', width: 90, height: 67, file_size: 1234 },
        { file_id: 'mid', width: 320, height: 240, file_size: 12000 },
        { file_id: 'big', width: 800, height: 600, file_size: 56789 },
      ],
      caption: 'hello',
    });
    expect(ref).not.toBeNull();
    expect(ref!.fileId).toBe('big');
    expect(ref!.fileSize).toBe(56789);
    expect(ref!.source).toBe('photo');
  });

  it('picks the largest entry even when file_size is missing (falls back to width*height)', () => {
    const ref = extractImageRefFromTelegramMessage({
      photo: [
        { file_id: 'a', width: 100, height: 100 },
        { file_id: 'b', width: 200, height: 200 },
      ],
    });
    expect(ref?.fileId).toBe('b');
  });

  it('returns an image/* document', () => {
    const ref = extractImageRefFromTelegramMessage({
      document: { file_id: 'doc1', mime_type: 'image/png', file_size: 5000 },
    });
    expect(ref).not.toBeNull();
    expect(ref!.fileId).toBe('doc1');
    expect(ref!.source).toBe('document');
    expect(ref!.mimeHint).toBe('image/png');
  });

  it('ignores non-image documents (PDF)', () => {
    const ref = extractImageRefFromTelegramMessage({
      document: { file_id: 'pdf1', mime_type: 'application/pdf', file_size: 50000 },
    });
    expect(ref).toBeNull();
  });

  it('returns null for a text-only message', () => {
    expect(extractImageRefFromTelegramMessage({ text: 'just words' })).toBeNull();
  });
});

describe('downloadTelegramFile', () => {
  it('resolves getFile then downloads bytes', async () => {
    const ff = new FetchFake()
      .on('getFile', () => ok({ ok: true, result: { file_path: 'photos/file_1.png' } }))
      .on('/file/bot', () => bytesResponse(new Uint8Array([1, 2, 3, 4])));
    const result = await downloadTelegramFile('FID', 'bot-token', ff.fetch);
    expect(result.bytes).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(result.mime_type).toBe('image/png');
    expect(result.ext).toBe('png');
    expect(ff.calls[0]?.url).toContain('getFile?file_id=FID');
  });

  it('throws a clear error when getFile returns 404', async () => {
    const ff = new FetchFake()
      .on('getFile', () => new Response('not found', { status: 404 }));
    await expect(downloadTelegramFile('FID', 'tok', ff.fetch))
      .rejects.toThrow(/Telegram getFile failed: 404/);
  });

  it('throws when the file download fails', async () => {
    const ff = new FetchFake()
      .on('getFile', () => ok({ ok: true, result: { file_path: 'x.jpg' } }))
      .on('/file/bot', () => new Response('boom', { status: 500 }));
    await expect(downloadTelegramFile('FID', 'tok', ff.fetch))
      .rejects.toThrow(/Telegram file download failed: 500/);
  });
});

describe('uploadToSupabaseStorage', () => {
  it('PUTs to the bucket and returns the public URL with conversation_id prefix', async () => {
    const ff = new FetchFake().on('/storage/v1/object/chat-uploads/', () => ok({ Key: 'ok' }));
    const url = await uploadToSupabaseStorage(
      new Uint8Array([1, 2, 3]),
      'image/png',
      'png',
      'https://example.supabase.co',
      'service-key',
      'session-abc',
      ff.fetch,
      () => 'uuid-1',
    );
    expect(url).toBe('https://example.supabase.co/storage/v1/object/public/chat-uploads/session-abc/uuid-1.png');
    const call = ff.calls[0]!;
    expect(call.url).toContain('/chat-uploads/session-abc/uuid-1.png');
    const headers = call.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer service-key');
    expect(headers['Content-Type']).toBe('image/png');
  });

  it('throws on upload failure', async () => {
    const ff = new FetchFake()
      .on('/storage/v1/object/chat-uploads/', () => new Response('bad mime', { status: 400 }));
    await expect(uploadToSupabaseStorage(
      new Uint8Array([1]), 'application/octet-stream', 'bin',
      'https://x.co', 'key', 'conv', ff.fetch, () => 'u1',
    )).rejects.toThrow(/Storage upload failed: 400/);
  });
});

describe('ingestTelegramImage', () => {
  it('refuses files that exceed the Anthropic size limit before downloading', async () => {
    const ff = new FetchFake();
    await expect(ingestTelegramImage(
      { fileId: 'big', fileSize: ANTHROPIC_IMAGE_MAX_BYTES + 1, mimeHint: null, source: 'photo' },
      { botToken: 'tok', supabaseUrl: 'https://x', serviceRoleKey: 'k', conversationId: 'c', fetchImpl: ff.fetch },
    )).rejects.toThrow(/Image too large/);
    expect(ff.calls).toHaveLength(0);
  });

  it('downloads and uploads end-to-end, returning the public URL', async () => {
    const bytes = new Uint8Array([10, 20, 30]);
    const ff = new FetchFake()
      .on('getFile', () => ok({ ok: true, result: { file_path: 'photos/x.jpg' } }))
      .on('/file/bot', () => bytesResponse(bytes))
      .on('/storage/v1/object/chat-uploads/', () => ok({ Key: 'ok' }));
    const result = await ingestTelegramImage(
      { fileId: 'F1', fileSize: bytes.length, mimeHint: null, source: 'photo' },
      {
        botToken: 'tok', supabaseUrl: 'https://x.co', serviceRoleKey: 'k',
        conversationId: 'sess-1', fetchImpl: ff.fetch, uuid: () => 'u-1',
      },
    );
    expect(result.url).toBe('https://x.co/storage/v1/object/public/chat-uploads/sess-1/u-1.jpg');
    expect(result.mime_type).toBe('image/jpeg');
    expect(result.byte_size).toBe(3);
    expect(result.source_file_id).toBe('F1');
  });
});

describe('buildUserMessageContent', () => {
  const image = {
    url: 'https://example.supabase.co/storage/v1/object/public/chat-uploads/c/u.png',
    mime_type: 'image/png',
    byte_size: 100,
    source_file_id: 'F',
  };

  it('returns the text as a string when no image is attached', () => {
    expect(buildUserMessageContent('hello world', null)).toBe('hello world');
  });

  it('returns image + caption blocks when both are present', () => {
    const out = buildUserMessageContent('what is this?', image) as AnthropicMessageContent[];
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ type: 'image', source: { type: 'url', url: image.url } });
    expect(out[1]).toEqual({ type: 'text', text: 'what is this?' });
  });

  it('uses the default prompt when the image has no caption', () => {
    const out = buildUserMessageContent('   ', image) as AnthropicMessageContent[];
    expect(out[1]).toEqual({ type: 'text', text: IMAGE_WITHOUT_CAPTION_PROMPT });
  });
});

describe('normaliseUserMessageContent', () => {
  it('preserves a plain string', () => {
    expect(normaliseUserMessageContent('hello')).toBe('hello');
  });

  it('preserves an array of content blocks', () => {
    const blocks: AnthropicMessageContent[] = [
      { type: 'image', source: { type: 'url', url: 'https://example/x.png' } },
      { type: 'text', text: 'caption' },
    ];
    expect(normaliseUserMessageContent(blocks)).toEqual(blocks);
  });

  it('returns empty string for null/undefined', () => {
    expect(normaliseUserMessageContent(null)).toBe('');
    expect(normaliseUserMessageContent(undefined)).toBe('');
  });

  it('extracts .text from a single block-like object', () => {
    expect(normaliseUserMessageContent({ type: 'text', text: 'hi' })).toBe('hi');
  });
});

describe('userMessageText', () => {
  it('returns the string as-is', () => {
    expect(userMessageText('hello')).toBe('hello');
  });

  it('joins text blocks from an array, ignoring images', () => {
    expect(userMessageText([
      { type: 'image', source: { type: 'url', url: 'https://x/y.png' } },
      { type: 'text', text: 'caption text' },
    ])).toBe('caption text');
  });

  it('returns empty string when no text blocks are present', () => {
    expect(userMessageText([
      { type: 'image', source: { type: 'url', url: 'https://x/y.png' } },
    ])).toBe('');
  });
});

describe('reconstructHistory: jsonb content shapes', () => {
  it('preserves array-shaped user content (image + text) from jsonb', () => {
    const userBlocks: AnthropicMessageContent[] = [
      { type: 'image', source: { type: 'url', url: 'https://x/y.png' } },
      { type: 'text', text: 'describe this' },
    ];
    const rows = [
      { role: 'user', content: userBlocks, tool_call_id: null, tool_name: null, tool_input: null, tool_output: null },
      { role: 'assistant', content: 'A bird.', tool_call_id: null, tool_name: null, tool_input: null, tool_output: null },
    ];
    const out = reconstructHistory(rows);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ role: 'user', content: userBlocks });
    expect((out[1]!.content as Array<{ type: string; text?: string }>)[0]).toEqual({ type: 'text', text: 'A bird.' });
  });

  it('preserves legacy string content rows', () => {
    const rows = [
      { role: 'user', content: 'plain text', tool_call_id: null, tool_name: null, tool_input: null, tool_output: null },
    ];
    expect(reconstructHistory(rows)[0]).toEqual({ role: 'user', content: 'plain text' });
  });
});

describe('runChat end-to-end with multimodal user message', () => {
  it('passes the image+text content array through to Anthropic and persists it', async () => {
    const fx = seedFakeDb();
    const anthropic = new FakeAnthropic([
      { text: 'A creature.', stopReason: 'end_turn', inputTokens: 100, outputTokens: 5 },
    ]);

    const userContent: AnthropicMessageContent[] = [
      { type: 'image', source: { type: 'url', url: 'https://example.supabase.co/storage/v1/object/public/chat-uploads/s1/img.png' } },
      { type: 'text', text: 'What is this?' },
    ];

    await collect(runChat({
      client: client(fx.db),
      anthropic,
      workspaceId: fx.workspaceId,
      userId: fx.userId,
      channel: 'telegram',
      userMessage: userContent,
      embedQueryFn: fakeQueryEmbedder,
    }));

    expect(anthropic.calls).toHaveLength(1);
    const sentMessages = anthropic.calls[0]!.messages;
    const lastUser = sentMessages.at(-1)!;
    expect(lastUser.role).toBe('user');
    expect(lastUser.content).toEqual(userContent);

    const persisted = fx.db.tableRows('messages');
    expect(persisted[0]?.role).toBe('user');
    expect(persisted[0]?.content).toEqual(userContent);
  });

  it('reconstructs the multimodal user message on a second turn', async () => {
    const fx = seedFakeDb();
    const anthropic = new FakeAnthropic([
      { text: 'first reply', stopReason: 'end_turn', inputTokens: 50, outputTokens: 5 },
      { text: 'second reply', stopReason: 'end_turn', inputTokens: 60, outputTokens: 5 },
    ]);

    const firstContent: AnthropicMessageContent[] = [
      { type: 'image', source: { type: 'url', url: 'https://example/img.png' } },
      { type: 'text', text: 'turn one' },
    ];
    const first = await collect(runChat({
      client: client(fx.db),
      anthropic,
      workspaceId: fx.workspaceId,
      userId: fx.userId,
      channel: 'telegram',
      userMessage: firstContent,
      embedQueryFn: fakeQueryEmbedder,
    }));
    const sessionEvent = first.find((e) => e.type === 'session') as { type: 'session'; session_id: string } | undefined;
    const sessionId = sessionEvent!.session_id;

    await collect(runChat({
      client: client(fx.db),
      anthropic,
      workspaceId: fx.workspaceId,
      userId: fx.userId,
      sessionId,
      channel: 'telegram',
      userMessage: 'turn two',
      embedQueryFn: fakeQueryEmbedder,
    }));

    const secondCallMessages = anthropic.calls[1]!.messages;
    const firstUserInSecondCall = secondCallMessages.find((m) => m.role === 'user');
    expect(firstUserInSecondCall?.content).toEqual(firstContent);
  });
});
