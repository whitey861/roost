import { describe, it, expect } from 'vitest';
import { generatePairingCode, parseApprovalCallback, parseSlashCommand } from '../shared/telegram-helpers.js';

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

describe('generatePairingCode', () => {
  it('returns a 6-digit string', () => {
    for (let i = 0; i < 50; i++) {
      const c = generatePairingCode();
      expect(c).toMatch(/^\d{6}$/);
    }
  });
});
