import { describe, expect, it } from 'vitest';
import { fuzzyFilter, fuzzyMatch } from '../../src/core/fuzzy';

describe('fuzzyMatch', () => {
  it('matches subsequences and reports positions', () => {
    const match = fuzzyMatch('pc', 'palette.commands');
    expect(match).not.toBeNull();
    expect(match?.positions).toEqual([0, 8]);
  });

  it('rejects non-subsequences', () => {
    expect(fuzzyMatch('zzz', 'palette')).toBeNull();
    expect(fuzzyMatch('palette', 'pal')).toBeNull();
  });

  it('prefers exact and prefix matches', () => {
    const exact = fuzzyMatch('save', 'save')!.score;
    const prefix = fuzzyMatch('save', 'save file')!.score;
    const scattered = fuzzyMatch('save', 's-a-v-e-now')!.score;
    expect(exact).toBeGreaterThan(prefix);
    expect(prefix).toBeGreaterThan(scattered);
  });

  it('is case-insensitive', () => {
    expect(fuzzyMatch('FILE', 'file.save')).not.toBeNull();
  });

  it('returns a zero score for an empty query', () => {
    expect(fuzzyMatch('', 'anything')).toEqual({ score: 0, positions: [] });
  });
});

describe('fuzzyFilter', () => {
  const items = ['File: Save', 'File: Save As', 'Edit: Undo', 'View: Zoom In'];

  it('ranks the closest match first', () => {
    const result = fuzzyFilter(items, 'save', (item) => item);
    expect(result[0]?.item).toBe('File: Save');
  });

  it('respects the limit', () => {
    const result = fuzzyFilter(items, 'i', (item) => item, 2);
    expect(result).toHaveLength(2);
  });

  it('returns nothing when no item matches', () => {
    expect(fuzzyFilter(items, 'qqqq', (item) => item)).toEqual([]);
  });
});
