import { describe, it, expect } from 'vitest';
import {
  extractFirstImageMarkdown,
  generatePairingCode,
  parseApprovalCallback,
  parseSlashCommand,
  parseSpawnArgs,
  sendChunkedReply,
  splitForTelegram,
  TELEGRAM_CAPTION_LIMIT,
  TELEGRAM_MESSAGE_LIMIT,
  TELEGRAM_SPLIT_THRESHOLD,
} from '../shared/telegram-helpers.js';

describe('parseSlashCommand', () => {
  it('parses /help with no arg', () => {
    expect(parseSlashCommand('/help')).toEqual({ command: 'help', arg: null });
  });
  it('parses /use <slug>', () => {
    expect(parseSlashCommand('/use kca')).toEqual({ command: 'use', arg: 'kca' });
  });
  it('parses /start <code>', () => {
    expect(parseSlashCommand('/start 123456')).toEqual({ command: 'start', arg: '123456' });
  });
  it('returns null for non-slash', () => {
    expect(parseSlashCommand('hello')).toBeNull();
  });
});

describe('parseApprovalCallback', () => {
  it('parses approve', () => {
    expect(parseApprovalCallback('act:approve:abc-123')).toEqual({ op: 'approve', actionId: 'abc-123' });
  });
  it('parses reject', () => {
    expect(parseApprovalCallback('act:reject:zzz')).toEqual({ op: 'reject', actionId: 'zzz' });
  });
  it('rejects malformed data', () => {
    expect(parseApprovalCallback('foo:bar')).toBeNull();
    expect(parseApprovalCallback('act:approve:')).toBeNull();
    expect(parseApprovalCallback('act:weirdop:abc')).toBeNull();
  });
  it('preserves uuids that contain colons', () => {
    expect(parseApprovalCallback('act:approve:a:b:c')).toEqual({ op: 'approve', actionId: 'a:b:c' });
  });
});

describe('parseSpawnArgs', () => {
  it('rejects empty arg with usage', () => {
    const r = parseSpawnArgs(null);
    expect('error' in r && r.error.startsWith('Usage:')).toBe(true);
    const r2 = parseSpawnArgs('   ');
    expect('error' in r2 && r2.error.startsWith('Usage:')).toBe(true);
  });

  it('parses repo only with defaults', () => {
    expect(parseSpawnArgs('whitey861/roost-test')).toEqual({
      repo: 'whitey861/roost-test',
      maxRuntimeMinutes: 120,
      maxCostUsd: 5.0,
    });
  });

  it('parses repo + minutes', () => {
    expect(parseSpawnArgs('whitey861/roost-test 180')).toEqual({
      repo: 'whitey861/roost-test',
      maxRuntimeMinutes: 180,
      maxCostUsd: 5.0,
    });
  });

  it('parses repo + minutes + cost', () => {
    expect(parseSpawnArgs('whitey861/roost-test 180 10')).toEqual({
      repo: 'whitey861/roost-test',
      maxRuntimeMinutes: 180,
      maxCostUsd: 10.0,
    });
  });

  it('accepts decimal cost', () => {
    const r = parseSpawnArgs('a/b 60 0.5');
    expect(r).toEqual({ repo: 'a/b', maxRuntimeMinutes: 60, maxCostUsd: 0.5 });
  });

  it('rejects malformed repo', () => {
    const r = parseSpawnArgs('not-a-repo');
    expect('error' in r && r.error.includes('owner/name')).toBe(true);
  });

  it('rejects non-integer minutes', () => {
    const r = parseSpawnArgs('a/b 30.5');
    expect('error' in r && r.error.includes('Minutes')).toBe(true);
  });

  it('rejects out-of-range minutes', () => {
    expect('error' in parseSpawnArgs('a/b 0')).toBe(true);
    expect('error' in parseSpawnArgs('a/b 721')).toBe(true);
  });

  it('rejects out-of-range cost', () => {
    expect('error' in parseSpawnArgs('a/b 60 0')).toBe(true);
    expect('error' in parseSpawnArgs('a/b 60 101')).toBe(true);
  });

  it('rejects extra args', () => {
    const r = parseSpawnArgs('a/b 60 5 extra');
    expect('error' in r && r.error.includes('Too many')).toBe(true);
  });
});

describe('extractFirstImageMarkdown', () => {
  it('returns null when the text has no image markdown', () => {
    expect(extractFirstImageMarkdown('just text')).toBeNull();
    expect(extractFirstImageMarkdown('a [link](https://example.com) only')).toBeNull();
  });

  it('extracts the URL, alt, and trimmed caption', () => {
    const r = extractFirstImageMarkdown('Here is the piece. ![oar fish](https://img.recraft.ai/x.png)');
    expect(r).toBeTruthy();
    expect(r!.imageUrl).toBe('https://img.recraft.ai/x.png');
    expect(r!.alt).toBe('oar fish');
    expect(r!.caption).toBe('Here is the piece.');
    expect(r!.captionOverflow).toBe(false);
  });

  it('only matches recognised image extensions', () => {
    expect(extractFirstImageMarkdown('![x](https://example.com/page)')).toBeNull();
    expect(extractFirstImageMarkdown('![x](https://example.com/x.svg)')).toBeNull();
    expect(extractFirstImageMarkdown('![x](https://example.com/x.png)')).toBeTruthy();
    expect(extractFirstImageMarkdown('![x](https://example.com/x.jpg)')).toBeTruthy();
    expect(extractFirstImageMarkdown('![x](https://example.com/x.jpeg)')).toBeTruthy();
    expect(extractFirstImageMarkdown('![x](https://example.com/x.gif)')).toBeTruthy();
    expect(extractFirstImageMarkdown('![x](https://example.com/x.webp)')).toBeTruthy();
  });

  it('flags captions that exceed the Telegram caption limit', () => {
    const long = 'x'.repeat(TELEGRAM_CAPTION_LIMIT + 50);
    const r = extractFirstImageMarkdown(`${long} ![a](https://e.com/i.png)`);
    expect(r?.captionOverflow).toBe(true);
  });

  it('picks the first image when multiple are present', () => {
    const r = extractFirstImageMarkdown(
      '![a](https://e.com/a.png) and ![b](https://e.com/b.png)',
    );
    expect(r?.imageUrl).toBe('https://e.com/a.png');
  });
});

describe('splitForTelegram', () => {
  it('returns an empty array for empty input', () => {
    expect(splitForTelegram('')).toEqual([]);
  });

  it('returns the input as a single chunk when it is under the threshold', () => {
    expect(splitForTelegram('hello world')).toEqual(['hello world']);
  });

  it('splits on paragraph boundaries when the text exceeds the threshold', () => {
    const a = 'a'.repeat(2000);
    const b = 'b'.repeat(2000);
    const c = 'c'.repeat(2000);
    const text = `${a}\n\n${b}\n\n${c}`;
    const chunks = splitForTelegram(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const ch of chunks) {
      expect(ch.length).toBeLessThanOrEqual(TELEGRAM_SPLIT_THRESHOLD);
    }
    // Each original paragraph is preserved intact in some chunk.
    expect(chunks.some((ch) => ch.includes(a))).toBe(true);
    expect(chunks.some((ch) => ch.includes(b))).toBe(true);
    expect(chunks.some((ch) => ch.includes(c))).toBe(true);
  });

  it('falls back to sentence boundaries when a single paragraph exceeds the threshold', () => {
    const sentence = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit.';
    const para = Array(120).fill(sentence).join(' ');
    expect(para.length).toBeGreaterThan(TELEGRAM_SPLIT_THRESHOLD);
    const chunks = splitForTelegram(para);
    expect(chunks.length).toBeGreaterThan(1);
    for (const ch of chunks) {
      expect(ch.length).toBeLessThanOrEqual(TELEGRAM_SPLIT_THRESHOLD);
      // Chunks should end at a sentence boundary (last character is a
      // sentence terminator), preserving readable formatting.
      expect(/[.!?]$/.test(ch.trim())).toBe(true);
    }
  });

  it('hard-splits as a last resort when no boundaries exist', () => {
    const giant = 'x'.repeat(10_000);
    const chunks = splitForTelegram(giant);
    expect(chunks.length).toBeGreaterThan(1);
    for (const ch of chunks) {
      expect(ch.length).toBeLessThanOrEqual(TELEGRAM_SPLIT_THRESHOLD);
    }
    expect(chunks.join('')).toBe(giant);
  });

  it('every chunk stays comfortably under the 4096-char Telegram limit', () => {
    const para = 'word '.repeat(800).trim();
    const text = Array(5).fill(para).join('\n\n');
    for (const ch of splitForTelegram(text)) {
      expect(ch.length).toBeLessThan(TELEGRAM_MESSAGE_LIMIT);
    }
  });
});

describe('sendChunkedReply', () => {
  it('uses a single editMessageText for short replies', async () => {
    const calls: Array<{ method: 'edit' | 'send'; text: string }> = [];
    const sender = {
      sendMessage: async (_chatId: number, text: string) => {
        calls.push({ method: 'send', text });
        return { message_id: 0, chat: { id: 0 } };
      },
      editMessageText: async (_chatId: number, _messageId: number, text: string) => {
        calls.push({ method: 'edit', text });
      },
    };
    await sendChunkedReply(sender, 1, 99, 'short reply');
    expect(calls).toEqual([{ method: 'edit', text: 'short reply' }]);
  });

  it('sends a 12000-char response as multiple sendMessage calls in order', async () => {
    // Build a 12000-char response with paragraph boundaries to exercise
    // the paragraph-split path. Each paragraph is short enough that the
    // sentence/hard-split fallbacks are not needed here.
    const paragraph = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(15).trim();
    const paragraphs: string[] = [];
    while (paragraphs.join('\n\n').length < 12000) {
      paragraphs.push(paragraph);
    }
    const text = paragraphs.join('\n\n');
    expect(text.length).toBeGreaterThanOrEqual(12000);

    const calls: Array<{ method: 'edit' | 'send'; chatId: number; text: string }> = [];
    const sender = {
      sendMessage: async (chatId: number, msg: string) => {
        calls.push({ method: 'send', chatId, text: msg });
        return { message_id: 100 + calls.length, chat: { id: chatId } };
      },
      editMessageText: async (chatId: number, _messageId: number, msg: string) => {
        calls.push({ method: 'edit', chatId, text: msg });
      },
    };

    const chunkCount = await sendChunkedReply(sender, 42, 99, text);

    // Returned chunk count matches the call count.
    expect(calls.length).toBe(chunkCount);

    // The placeholder is replaced by editMessageText with chunk 1; every
    // subsequent chunk is sent as a new sendMessage.
    expect(calls[0]!.method).toBe('edit');
    expect(calls.slice(1).every((c) => c.method === 'send')).toBe(true);

    // "Multiple sendMessage calls" — at least 2 follow-up messages for
    // a 12000-char response chunked at 3500 chars.
    const sendCalls = calls.filter((c) => c.method === 'send');
    expect(sendCalls.length).toBeGreaterThanOrEqual(2);

    // All chunks are under the threshold (and therefore under the
    // 4096-char Telegram per-message limit).
    for (const c of calls) {
      expect(c.text.length).toBeLessThanOrEqual(TELEGRAM_SPLIT_THRESHOLD);
    }

    // All chunks routed to the same chat id, in order.
    for (const c of calls) {
      expect(c.chatId).toBe(42);
    }

    // The chunks reassemble (paragraph-separated) to the original text,
    // preserving the original ordering.
    expect(calls.map((c) => c.text).join('\n\n')).toBe(text);
  });

  it('falls back to a "(no reply)" edit when the buffer is empty', async () => {
    const calls: string[] = [];
    const sender = {
      sendMessage: async () => {
        calls.push('send');
        return { message_id: 0, chat: { id: 0 } };
      },
      editMessageText: async (_c: number, _m: number, text: string) => {
        calls.push(`edit:${text}`);
      },
    };
    await sendChunkedReply(sender, 1, 99, '');
    expect(calls).toEqual(['edit:(no reply)']);
  });
});

describe('generatePairingCode', () => {
  it('returns a 6-digit string', () => {
    for (let i = 0; i < 50; i++) {
      const c = generatePairingCode();
      expect(c).toMatch(/^\d{6}$/);
    }
  });
});
