/**
 * Low-level text helpers shared by every platform shell.
 *
 * Positions are UTF-16 code unit offsets — the same unit the DOM, `textarea`
 * and `Selection` APIs speak. Grapheme helpers exist for *movement*, not for
 * addressing, so an emoji is never split in half by the caret.
 */

export type LineEnding = '\n' | '\r\n';

export function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  return value < min ? min : value > max ? max : value;
}

export function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

/** Detect the dominant line ending so saves can round-trip byte-for-byte. */
export function detectLineEnding(text: string): LineEnding {
  const crlf = countOccurrences(text, '\r\n');
  const lf = countOccurrences(text, '\n') - crlf;
  return crlf > lf ? '\r\n' : '\n';
}

/** Internal buffers are always LF; the original ending is restored on save. */
export function normalizeNewlines(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

export function restoreLineEnding(text: string, eol: LineEnding): string {
  return eol === '\n' ? text : text.replace(/\n/g, '\r\n');
}

interface SegmenterLike {
  segment(input: string): Iterable<{ index: number; segment: string }>;
}

const segmenter: SegmenterLike | null = (() => {
  const intl = Intl as unknown as {
    Segmenter?: new (
      locales?: string | string[],
      options?: { granularity: 'grapheme' },
    ) => SegmenterLike;
  };
  if (typeof intl.Segmenter !== 'function') return null;
  try {
    return new intl.Segmenter(undefined, { granularity: 'grapheme' });
  } catch {
    return null;
  }
})();

/** How many characters a single visible character occupies (emoji: 2, `e\u0301`: 2). */
export function graphemeLength(text: string): number {
  if (!segmenter) return text.length;
  let count = 0;
  for (const _ of segmenter.segment(text)) count += 1;
  return count;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

/** Offset of the grapheme boundary strictly before `offset`. */
export function previousGraphemeBoundary(text: string, offset: number): number {
  const at = clamp(offset, 0, text.length);
  if (at <= 0) return 0;
  if (!segmenter) {
    const code = text.charCodeAt(at - 1);
    return isLowSurrogate(code) ? Math.max(0, at - 2) : at - 1;
  }
  const from = Math.max(0, at - 64);
  const slice = text.slice(from, at);
  let boundary = from;
  for (const part of segmenter.segment(slice)) boundary = from + part.index;
  return boundary;
}

/** Offset of the grapheme boundary strictly after `offset`. */
export function nextGraphemeBoundary(text: string, offset: number): number {
  const at = clamp(offset, 0, text.length);
  if (at >= text.length) return text.length;
  if (!segmenter) {
    const code = text.charCodeAt(at);
    return isHighSurrogate(code) ? Math.min(text.length, at + 2) : at + 1;
  }
  const to = Math.min(text.length, at + 64);
  const slice = text.slice(at, to);
  const first = segmenter.segment(slice)[Symbol.iterator]().next();
  const size = first.done ? slice.length : first.value.segment.length || slice.length;
  return Math.min(text.length, at + size);
}
