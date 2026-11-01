import { describe, expect, it } from 'vitest';
import { TextDocument } from '../../src/core/document';
import {
  applyConcurrentEdits,
  applyConcurrentEditsWithCarets,
  applySequentialEdits,
  createEdits,
  invertEdits,
  normalizeEdits,
} from '../../src/core/edits';

const doc = (text: string) => new TextDocument(text);

describe('normalizeEdits', () => {
  it('merges overlapping deletes into one region', () => {
    const merged = normalizeEdits([
      { from: 5, to: 10, text: '' },
      { from: 8, to: 12, text: '' },
    ]);
    expect(merged).toEqual([{ from: 5, to: 12, text: '' }]);
  });

  it('joins two insertions at the same offset', () => {
    const merged = normalizeEdits([
      { from: 3, to: 3, text: 'a' },
      { from: 3, to: 3, text: 'b' },
    ]);
    expect(merged).toEqual([{ from: 3, to: 3, text: 'ab' }]);
  });

  it('keeps disjoint edits separate and sorted', () => {
    const merged = normalizeEdits([
      { from: 9, to: 9, text: 'z' },
      { from: 1, to: 1, text: 'y' },
    ]);
    expect(merged).toEqual([
      { from: 1, to: 1, text: 'y' },
      { from: 9, to: 9, text: 'z' },
    ]);
  });

  it('drops inverted edits instead of corrupting the buffer', () => {
    expect(normalizeEdits([{ from: 8, to: 2, text: 'x' }])).toEqual([]);
  });
});

describe('applyConcurrentEdits', () => {
  it('applies disjoint edits right to left', () => {
    const result = applyConcurrentEdits(doc('abcdef'), [
      { from: 1, to: 2, text: 'B' },
      { from: 4, to: 5, text: 'E' },
    ]);
    expect(result.text).toBe('aBcdEf');
  });

  it('deletes an overlapping region once', () => {
    const result = applyConcurrentEdits(doc('abcdefghij'), [
      { from: 2, to: 5, text: '' },
      { from: 4, to: 7, text: '' },
    ]);
    expect(result.text).toBe('abhij');
  });
});

describe('applyConcurrentEditsWithCarets', () => {
  it('lands each caret after its own insertion', () => {
    const { doc: next, carets } = applyConcurrentEditsWithCarets(doc('abc'), [
      { from: 0, to: 0, text: 'x' },
      { from: 2, to: 2, text: 'x' },
    ]);
    expect(next.text).toBe('xabxc');
    // Insert at 0 shifts the second caret right by one.
    expect(carets).toEqual([1, 4]);
  });

  it('reports one caret per edit even when edits merge', () => {
    const { doc: next, carets } = applyConcurrentEditsWithCarets(doc('abcdef'), [
      { from: 2, to: 4, text: '' },
      { from: 3, to: 5, text: '' },
    ]);
    expect(next.text).toBe('abf');
    expect(carets).toEqual([2, 2]);
  });

  it('handles a realistic multi-cursor wrap', () => {
    const { doc: next, carets } = applyConcurrentEditsWithCarets(doc('one two one'), [
      { from: 0, to: 3, text: 'ONE' },
      { from: 8, to: 11, text: 'ONE' },
    ]);
    expect(next.text).toBe('ONE two ONE');
    expect(carets).toEqual([3, 11]);
  });

  it('is a no-op for zero edits', () => {
    const { doc: next, carets } = applyConcurrentEditsWithCarets(doc('abc'), []);
    expect(next.text).toBe('abc');
    expect(carets).toEqual([]);
  });
});

describe('createEdits / invertEdits', () => {
  it('round-trips through inversion', () => {
    const source = doc('hello world');
    const edits = createEdits(source, [{ from: 6, to: 11, text: 'there' }]);
    expect(edits[0]?.removed).toBe('world');
    const applied = applySequentialEdits(source, edits);
    expect(applied.text).toBe('hello there');
    const reverted = applySequentialEdits(applied, invertEdits(edits));
    expect(reverted.text).toBe('hello world');
  });

  it('inverts a sequence of inserts in reverse order', () => {
    const source = doc('abc');
    const edits = createEdits(source, [
      { from: 0, to: 0, text: 'x' },
      { from: 2, to: 2, text: 'y' },
    ]);
    const applied = applySequentialEdits(source, edits);
    expect(applied.text).toBe('xaybc');
    expect(applySequentialEdits(applied, invertEdits(edits)).text).toBe('abc');
  });
});
