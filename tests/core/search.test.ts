import { describe, expect, it } from 'vitest';
import { Search, expandReplacement } from '../../src/core/search';

describe('Search matching', () => {
  it('is case-insensitive by default', () => {
    const search = new Search({ query: 'foo' });
    expect(search.matches('FOO foo Foo')).toHaveLength(3);
  });

  it('honours case sensitivity', () => {
    const search = new Search({ query: 'foo', caseSensitive: true });
    expect(search.matches('FOO foo Foo')).toEqual([{ from: 4, to: 7 }]);
  });

  it('treats regex metacharacters literally by default', () => {
    const search = new Search({ query: 'a.c' });
    expect(search.matches('abc a.c')).toEqual([{ from: 4, to: 7 }]);
  });

  it('supports regular expressions', () => {
    const search = new Search({ query: '\\d+', regex: true });
    expect(search.matches('a1 bb22 c333')).toEqual([
      { from: 1, to: 2 },
      { from: 5, to: 7 },
      { from: 9, to: 12 },
    ]);
  });

  it('reports invalid patterns instead of throwing', () => {
    const search = new Search({ query: '(', regex: true });
    expect(search.error).toBeTruthy();
    expect(search.isValid).toBe(false);
    expect(search.matches('anything')).toEqual([]);
  });

  it('filters whole-word matches', () => {
    const search = new Search({ query: 'cat', wholeWord: true });
    expect(search.matches('concatenate cat cats _cat cat_')).toEqual([{ from: 12, to: 15 }]);
  });

  it('returns nothing for an empty query', () => {
    const search = new Search({ query: '' });
    expect(search.isEmpty).toBe(true);
    expect(search.matches('abc')).toEqual([]);
  });

  it('does not hang on zero-length patterns', () => {
    const search = new Search({ query: '^|$', regex: true });
    const matches = search.matches('ab\ncd');
    expect(matches.length).toBeGreaterThan(0);
    expect(matches.length).toBeLessThan(20);
  });

  it('respects the match limit', () => {
    const search = new Search({ query: 'a' });
    expect(search.matches('a'.repeat(100), 10)).toHaveLength(10);
  });
});

describe('Search replacement', () => {
  it('replaces literally without expanding $ patterns', () => {
    const search = new Search({ query: 'cat' });
    const result = search.replaceAll('cat and cat', '$&$1');
    expect(result.count).toBe(2);
    expect(result.text).toBe('$&$1 and $&$1');
  });

  it('expands capture groups in regex mode', () => {
    const search = new Search({ query: '(\\w+)@(\\w+)', regex: true });
    const result = search.replaceAll('me@example you@here', '$2:$1');
    expect(result.count).toBe(2);
    expect(result.text).toBe('example:me here:you');
  });

  it('is case-insensitive when replacing', () => {
    const search = new Search({ query: 'foo' });
    expect(search.replaceAll('FOO Foo', 'bar').text).toBe('bar bar');
  });

  it('leaves text untouched when nothing matches', () => {
    const search = new Search({ query: 'zzz' });
    expect(search.replaceAll('abc', 'x')).toEqual({ text: 'abc', count: 0 });
  });

  it('replaces only whole words when asked', () => {
    const search = new Search({ query: 'cat', wholeWord: true });
    expect(search.replaceAll('concatenate cat', 'dog').text).toBe('concatenate dog');
  });
});

describe('expandReplacement', () => {
  const raw = /(\w+)-(\w+)/.exec('ab-cd')!;

  it('supports $$ and $&', () => {
    expect(expandReplacement('$$', raw)).toBe('$');
    expect(expandReplacement('[$&]', raw)).toBe('[ab-cd]');
  });

  it('supports numbered and named groups', () => {
    expect(expandReplacement('$2/$1', raw)).toBe('cd/ab');
    expect(expandReplacement('$0', raw)).toBe('ab-cd');
  });

  it('falls back to a literal digit for out-of-range groups', () => {
    const single = /(a)/.exec('a')!;
    expect(expandReplacement('$10', single)).toBe('a0');
  });

  it('supports the before/after tokens', () => {
    const match = /b/.exec('abc')!;
    expect(expandReplacement("$`|$'", match)).toBe('a|c');
  });
});

describe('nextIndex', () => {
  const search = new Search({ query: 'a' });
  const matches = search.matches('aaaa');

  it('wraps forward', () => {
    expect(search.nextIndex(matches, 0, 'forward')).toBe(1);
    expect(search.nextIndex(matches, 3, 'forward')).toBe(0);
  });

  it('wraps backward', () => {
    expect(search.nextIndex(matches, 4, 'backward')).toBe(3);
    expect(search.nextIndex(matches, 0, 'backward')).toBe(3);
  });

  it('returns -1 for no matches', () => {
    expect(search.nextIndex([], 0, 'forward')).toBe(-1);
  });
});
