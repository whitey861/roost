import { describe, it, expect } from 'vitest';
import {
  extractFirstImageMarkdown,
  generatePairingCode,
  parseApprovalCallback,
  parseSlashCommand,
  parseSpawnArgs,
  TELEGRAM_CAPTION_LIMIT,
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

describe('generatePairingCode', () => {
  it('returns a 6-digit string', () => {
    for (let i = 0; i < 50; i++) {
      const c = generatePairingCode();
      expect(c).toMatch(/^\d{6}$/);
    }
  });
});
