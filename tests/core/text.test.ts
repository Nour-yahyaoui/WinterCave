import { describe, expect, it } from 'vitest';
import {
  clamp,
  countOccurrences,
  detectLineEnding,
  graphemeLength,
  nextGraphemeBoundary,
  normalizeNewlines,
  previousGraphemeBoundary,
  restoreLineEnding,
} from '../../src/core/text';

describe('line endings', () => {
  it('detects the dominant ending', () => {
    expect(detectLineEnding('a\r\nb\r\nc')).toBe('\r\n');
    expect(detectLineEnding('a\nb\nc')).toBe('\n');
    expect(detectLineEnding('')).toBe('\n');
    expect(detectLineEnding('solo')).toBe('\n');
    // A lone CR is treated as a newline when normalising, not as LF evidence.
    expect(detectLineEnding('a\rb')).toBe('\n');
  });

  it('round-trips CRLF text byte-for-byte', () => {
    const original = 'line one\r\nline two\r\n';
    expect(restoreLineEnding(normalizeNewlines(original), detectLineEnding(original))).toBe(original);
  });

  it('does not double-convert when normalising twice', () => {
    expect(normalizeNewlines(normalizeNewlines('a\r\nb'))).toBe('a\nb');
    expect(restoreLineEnding('a\nb', '\n')).toBe('a\nb');
  });

  it('counts non-overlapping occurrences', () => {
    expect(countOccurrences('aaaa', 'aa')).toBe(2);
    expect(countOccurrences('aaa', '')).toBe(0);
  });
});

describe('grapheme movement', () => {
  it('never splits a surrogate pair', () => {
    const text = 'a😀b';
    expect(graphemeLength(text)).toBe(3);
    expect(nextGraphemeBoundary(text, 1)).toBe(3);
    expect(previousGraphemeBoundary(text, 3)).toBe(1);
    expect(previousGraphemeBoundary(text, 4)).toBe(3);
  });

  it('treats a combining mark as part of the character before it', () => {
    const text = 'e\u0301x';
    expect(graphemeLength(text)).toBe(2);
    expect(nextGraphemeBoundary(text, 0)).toBe(2);
    expect(previousGraphemeBoundary(text, 2)).toBe(0);
  });

  it('clamps at the edges', () => {
    expect(previousGraphemeBoundary('abc', 0)).toBe(0);
    expect(nextGraphemeBoundary('abc', 3)).toBe(3);
    expect(nextGraphemeBoundary('abc', 99)).toBe(3);
  });

  it('handles emoji sequences with joiners', () => {
    const family = '👨‍👩‍👧';
    expect(previousGraphemeBoundary(family, family.length)).toBe(0);
    expect(nextGraphemeBoundary(family, 0)).toBe(family.length);
  });
});

describe('clamp', () => {
  it('bounds values and survives NaN', () => {
    expect(clamp(5, 0, 3)).toBe(3);
    expect(clamp(-1, 0, 3)).toBe(0);
    expect(clamp(Number.NaN, 0, 3)).toBe(0);
  });
});
