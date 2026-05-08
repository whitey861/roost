#!/usr/bin/env tsx
// Roost: runtime parity check.
// Confirms that paired source files have byte-equivalent canonical
// sections (modulo comments and whitespace). Fails CI if any pair drifts.
//
// Each entry in PAIRS is two file paths whose SHARED_RUNTIME_START /
// SHARED_RUNTIME_END region must match.

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

export const PAIRS: Array<[string, string]> = [
  ['shared/chat-runtime.ts', 'supabase/functions/_shared/chat-runtime.ts'],
  ['shared/retrieval.ts', 'supabase/functions/_shared/retrieval.ts'],
];

// Backwards compat: tests and historical callers still import FILES.
export const FILES: string[] = PAIRS.flat();

export const START_MARKER = '// SHARED_RUNTIME_START';
export const END_MARKER = '// SHARED_RUNTIME_END';

export function extractCanonical(filePath: string): string {
  const content = readFileSync(resolve(filePath), 'utf-8');
  return extractCanonicalFromString(content, filePath);
}

export function extractCanonicalFromString(content: string, label = '<input>'): string {
  // Markers must appear on their own line (preceded by start-of-string or
  // newline, possibly indented, and followed by end-of-line or end-of-string).
  // This avoids matching the literal marker text inside header comments.
  const startRe = /(?:^|\n)[ \t]*\/\/[ \t]*SHARED_RUNTIME_START[ \t]*(?:\r?\n|$)/;
  const endRe = /(?:^|\n)[ \t]*\/\/[ \t]*SHARED_RUNTIME_END[ \t]*(?:\r?\n|$)/;
  const startMatch = startRe.exec(content);
  const endMatch = endRe.exec(content);

  if (!startMatch || !endMatch) {
    throw new Error(
      `${label} is missing parity markers (${START_MARKER} / ${END_MARKER})`,
    );
  }
  const startIdx = startMatch.index + startMatch[0].length;
  const endIdx = endMatch.index;
  if (endIdx < startIdx) {
    throw new Error(`${label} has markers in the wrong order`);
  }

  let section = content.slice(startIdx, endIdx);

  // Strip block comments.
  section = section.replace(/\/\*[\s\S]*?\*\//g, '');
  // Strip line comments.
  section = section.replace(/\/\/.*$/gm, '');
  // Normalise whitespace.
  section = section.replace(/\s+/g, ' ').trim();

  return section;
}

export function hashSection(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 16);
}

export function main(): void {
  console.log('Runtime parity check:');
  let failed = false;

  for (const [a, b] of PAIRS) {
    const ha = hashSection(extractCanonical(a));
    const hb = hashSection(extractCanonical(b));
    console.log(`  ${ha}  ${a}`);
    console.log(`  ${hb}  ${b}`);
    if (ha !== hb) {
      console.error('');
      console.error(`FAIL: ${a} and ${b} have diverged.`);
      failed = true;
    }
  }

  if (failed) {
    console.error('');
    console.error(
      `Paired files must contain identical logic between ${START_MARKER} and ${END_MARKER} markers (modulo comments and whitespace).`,
    );
    console.error('If a divergence is intentional, update both files to match.');
    process.exit(1);
  }

  console.log('');
  console.log('OK: All paired runtime files in sync.');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
