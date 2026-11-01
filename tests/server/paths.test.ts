import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { assertRelativePath, baseName, isInside, PathError, resolveInside } from '../../server/paths.ts';

describe('assertRelativePath', () => {
  it('accepts ordinary relative paths', () => {
    expect(assertRelativePath('notes.md')).toBe('notes.md');
    expect(assertRelativePath('src/core/document.ts')).toBe('src/core/document.ts');
    expect(assertRelativePath('with space/file name.txt')).toBe('with space/file name.txt');
  });

  it('normalises Windows separators', () => {
    expect(assertRelativePath('src\\core\\x.ts')).toBe('src/core/x.ts');
  });

  it('rejects escapes and nonsense', () => {
    const bad = ['', '..', '../x', 'a/../../b', '/etc/passwd', 'C:/Windows', 'a//b', './a', 'a\0b'];
    for (const candidate of bad) {
      expect(() => assertRelativePath(candidate), candidate).toThrow(PathError);
    }
    expect(() => assertRelativePath(undefined)).toThrow(PathError);
    expect(() => assertRelativePath('x'.repeat(5000))).toThrow(PathError);
  });
});

describe('resolveInside', () => {
  it('joins inside the root', () => {
    expect(resolveInside('/work', 'a/b.txt')).toBe(path.resolve('/work/a/b.txt'));
  });

  it('keeps a sibling directory with a shared prefix out', () => {
    expect(() => resolveInside('/work', 'a/../../../work-evil/x')).toThrow(PathError);
  });
});

describe('isInside', () => {
  it('accepts children but not siblings', () => {
    expect(isInside('/work', '/work/a.txt')).toBe(true);
    expect(isInside('/work', '/work')).toBe(true);
    expect(isInside('/work', '/work-evil/a.txt')).toBe(false);
    expect(isInside('/work', '/etc/passwd')).toBe(false);
  });
});

describe('baseName', () => {
  it('returns the last segment', () => {
    expect(baseName('a/b/c.txt')).toBe('c.txt');
    expect(baseName('c.txt')).toBe('c.txt');
    expect(baseName('a/b/')).toBe('b');
  });
});
