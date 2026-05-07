import { describe, it, expect } from 'vitest';
import { extractCanonicalFromString, hashSection, START_MARKER, END_MARKER } from '../scripts/check-runtime-parity.js';

const wrap = (body: string): string => `// imports outside\nconst x = 1;\n${START_MARKER}\n${body}\n${END_MARKER}\n// helpers outside\n`;

describe('runtime parity helpers', () => {
  it('happy path: identical bodies hash equal', () => {
    const a = wrap('export function f() { return 1; }');
    const b = wrap('export function f() { return 1; }');
    expect(hashSection(extractCanonicalFromString(a, 'a'))).toBe(hashSection(extractCanonicalFromString(b, 'b')));
  });

  it('whitespace differences are ignored', () => {
    const a = wrap('export function f() { return 1; }');
    const b = wrap('export   function f()  {\n\n  return 1;\n}');
    expect(hashSection(extractCanonicalFromString(a, 'a'))).toBe(hashSection(extractCanonicalFromString(b, 'b')));
  });

  it('line comment differences are ignored', () => {
    const a = wrap('// note A\nexport function f() { return 1; }');
    const b = wrap('// completely different note\nexport function f() {\n  // inline\n  return 1;\n}');
    expect(hashSection(extractCanonicalFromString(a, 'a'))).toBe(hashSection(extractCanonicalFromString(b, 'b')));
  });

  it('block comment differences are ignored', () => {
    const a = wrap('/* purpose */ export function f() { return 1; }');
    const b = wrap('/* very different commentary\nspanning multiple lines */\nexport function f() { return 1; }');
    expect(hashSection(extractCanonicalFromString(a, 'a'))).toBe(hashSection(extractCanonicalFromString(b, 'b')));
  });

  it('real divergence in logic produces different hashes', () => {
    const a = wrap('export function f() { return 1; }');
    const b = wrap('export function f() { return 2; }');
    expect(hashSection(extractCanonicalFromString(a, 'a'))).not.toBe(hashSection(extractCanonicalFromString(b, 'b')));
  });

  it('order swap is a divergence', () => {
    const a = wrap('a(); b();');
    const b = wrap('b(); a();');
    expect(hashSection(extractCanonicalFromString(a, 'a'))).not.toBe(hashSection(extractCanonicalFromString(b, 'b')));
  });

  it('throws a clear error when start marker is missing', () => {
    const bad = `// no markers\nconst x = 1;\n${END_MARKER}\n`;
    expect(() => extractCanonicalFromString(bad, 'bad.ts')).toThrowError(/missing parity markers/);
  });

  it('throws a clear error when end marker is missing', () => {
    const bad = `${START_MARKER}\nconst x = 1;\n// no end\n`;
    expect(() => extractCanonicalFromString(bad, 'bad.ts')).toThrowError(/missing parity markers/);
  });

  it('throws a clear error when markers are reversed', () => {
    const bad = `${END_MARKER}\nconst x = 1;\n${START_MARKER}\n`;
    expect(() => extractCanonicalFromString(bad, 'bad.ts')).toThrowError(/wrong order/);
  });
});

describe('parity script: actual files', () => {
  it('the two real chat-runtime files are in sync', async () => {
    const { extractCanonical } = await import('../scripts/check-runtime-parity.js');
    const a = hashSection(extractCanonical('shared/chat-runtime.ts'));
    const b = hashSection(extractCanonical('supabase/functions/_shared/chat-runtime.ts'));
    expect(a).toBe(b);
  });
});
