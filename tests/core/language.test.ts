import { describe, expect, it } from 'vitest';
import {
  EMPTY_HIGHLIGHT_STATE,
  HighlightCache,
  arrayLineSource,
  flattenTokens,
  getLanguage,
  languageForFilename,
  tokenizeLine,
  tokenizeLines,
} from '../../src/core/language';

const typesOf = (line: string, id: string) => {
  const language = getLanguage(id);
  const { tokens } = tokenizeLine(line, language, EMPTY_HIGHLIGHT_STATE);
  const flat = flattenTokens(line, tokens);
  return flat.map((token) => `${token.type}:${line.slice(token.start, token.end)}`);
};

describe('language detection', () => {
  it('maps extensions to languages', () => {
    expect(languageForFilename('app.ts').id).toBe('typescript');
    expect(languageForFilename('style.css').id).toBe('css');
    expect(languageForFilename('README.md').id).toBe('markdown');
    expect(languageForFilename('no-extension').id).toBe('plaintext');
    expect(languageForFilename('weird.zzz').id).toBe('plaintext');
  });

  it('falls back to plain text for unknown ids', () => {
    expect(getLanguage('klingon').id).toBe('plaintext');
  });
});

describe('code tokenizing', () => {
  it('marks keywords, strings, numbers and comments', () => {
    expect(typesOf('const answer = 42; // yes', 'javascript')).toEqual([
      'keyword:const',
      'operator:=',
      'number:42',
      'comment:// yes',
    ]);
  });

  it('does not treat a keyword prefix as a keyword', () => {
    expect(typesOf('constant = 1', 'javascript')).toEqual(['operator:=', 'number:1']);
  });

  it('does not highlight a keyword inside a string', () => {
    expect(typesOf('const s = "const return"', 'javascript')).toEqual([
      'keyword:const',
      'operator:=',
      'string:"const return"',
    ]);
  });

  it('carries block comments across lines', () => {
    const language = getLanguage('javascript');
    const first = tokenizeLine('code /* start', language, EMPTY_HIGHLIGHT_STATE);
    expect(first.state.blockComment).toBe('*/');
    const second = tokenizeLine('still comment */ code()', language, first.state);
    expect(second.state.blockComment).toBeNull();
    expect(second.tokens[0]).toEqual({ start: 0, end: 16, type: 'comment' });
  });

  it('carries template literals across lines', () => {
    const language = getLanguage('typescript');
    const first = tokenizeLine('const t = `line one', language, EMPTY_HIGHLIGHT_STATE);
    expect(first.state.string).toBe('`');
    const second = tokenizeLine('line two`', language, first.state);
    expect(second.state.string).toBeNull();
  });

  it('handles escapes inside strings', () => {
    expect(typesOf('const s = "a\\"b";', 'javascript')).toEqual([
      'keyword:const',
      'operator:=',
      'string:"a\\"b"',
    ]);
  });

  it('highlights JSON constants and keys', () => {
    expect(typesOf('{"a": true}', 'json')).toEqual([
      'string:"a"',
      'operator::',
      'constant:true',
    ]);
  });

  it('highlights CSS properties and selectors', () => {
    const tokens = typesOf('.card { color: red; }', 'css');
    expect(tokens).toContain('tag:.card');
    expect(tokens).toContain('attribute:color');
  });

  it('highlights HTML attributes and values over the tag', () => {
    const tokens = typesOf('<a href="/x">go</a>', 'html');
    expect(tokens[0]).toBe('tag:<a ');
    expect(tokens).toContain('attribute:href');
    expect(tokens).toContain('string:"/x"');
    expect(tokens).toContain('tag:</a>');
  });

  it('treats SQL keywords case-insensitively', () => {
    expect(typesOf('SELECT * FROM t', 'sql')).toContain('keyword:SELECT');
  });

  it('produces no tokens for plain text', () => {
    expect(typesOf('just words', 'plaintext')).toEqual([]);
  });
});

describe('markdown tokenizing', () => {
  it('highlights headings, lists and inline spans', () => {
    expect(typesOf('## Title', 'markdown')).toEqual(['heading:## Title']);
    expect(typesOf('- item', 'markdown')).toEqual(['list:-']);
    expect(typesOf('a `code` and **bold**', 'markdown')).toEqual([
      'code:`code`',
      'strong:**bold**',
    ]);
  });

  it('marks fenced code and closes it', () => {
    const language = getLanguage('markdown');
    const open = tokenizeLine('```js', language, EMPTY_HIGHLIGHT_STATE);
    expect(open.state.fence).toBe(true);
    const inside = tokenizeLine('const x = 1;', language, open.state);
    expect(inside.tokens[0]).toEqual({ start: 0, end: 12, type: 'code' });
    const close = tokenizeLine('```', language, inside.state);
    expect(close.state.fence).toBe(false);
  });

  it('does not read inline markers inside a fence', () => {
    const language = getLanguage('markdown');
    const state = tokenizeLine('```', language, EMPTY_HIGHLIGHT_STATE).state;
    const line = tokenizeLine('# not a heading', language, state);
    expect(line.tokens[0]?.type).toBe('code');
  });
});

describe('tokenizeLines windows', () => {
  it('replays state from the top for a window', () => {
    const lines = ['/* open', 'still', 'close */', 'const a = 1;'];
    const tokenized = tokenizeLines(lines, getLanguage('javascript'), { from: 1, to: 4 });
    expect(tokenized.has(0)).toBe(false);
    expect(tokenized.get(1)?.tokens[0]?.type).toBe('comment');
    expect(tokenized.get(3)?.tokens.some((token) => token.type === 'keyword')).toBe(true);
  });
});

describe('flattenTokens', () => {
  it('lets later tokens win and merges adjacent runs', () => {
    const flat = flattenTokens('abcdef', [
      { start: 0, end: 4, type: 'tag' },
      { start: 2, end: 3, type: 'attribute' },
    ]);
    expect(flat).toEqual([
      { start: 0, end: 2, type: 'tag' },
      { start: 2, end: 3, type: 'attribute' },
      { start: 3, end: 4, type: 'tag' },
    ]);
  });

  it('ignores tokens outside the line', () => {
    expect(flattenTokens('ab', [{ start: 5, end: 9, type: 'string' }])).toEqual([]);
  });
});

describe('HighlightCache', () => {
  const lines = [
    'const a = 1;',
    '/* comment',
    'still comment',
    'end */ const b = 2;',
    'const c = "str";',
  ];

  it('matches full tokenization for a window', () => {
    const cache = new HighlightCache();
    const windowed = cache.window(arrayLineSource(lines), getLanguage('javascript'), 2, 5);
    const full = tokenizeLines(lines, getLanguage('javascript'), { from: 2, to: 5 });
    for (let index = 2; index < 5; index += 1) {
      expect(windowed.get(index)).toEqual(full.get(index)?.tokens);
    }
  });

  it('reuses cached lines without changing results', () => {
    const cache = new HighlightCache();
    cache.window(arrayLineSource(lines), getLanguage('javascript'), 0, 3);
    const second = cache.window(arrayLineSource(lines), getLanguage('javascript'), 0, 5);
    expect(second.get(1)?.[0]?.type).toBe('comment');
    expect(second.get(4)?.[0]?.type).toBe('keyword');
  });

  it('recomputes after an invalidation that opens a block comment', () => {
    const cache = new HighlightCache();
    const language = getLanguage('javascript');
    cache.window(arrayLineSource(lines), language, 0, 5);
    const edited = ['const a = 1;', '/* comment', 'still comment', 'end */ const b = 2;', 'const c = "str";'];
    edited[0] = 'const a = 1; /* opened here';
    cache.invalidateFrom(0);
    const refreshed = cache.window(arrayLineSource(edited), language, 3, 4);
    expect(refreshed.get(3)?.[0]?.type).toBe('comment');
  });

  it('starts over when the language changes', () => {
    const cache = new HighlightCache();
    cache.window(arrayLineSource(lines), getLanguage('javascript'), 0, 5);
    const asMarkdown = cache.window(arrayLineSource(['# heading']), getLanguage('markdown'), 0, 1);
    expect(asMarkdown.get(0)?.[0]?.type).toBe('heading');
    expect(cache.size).toBe(1);
  });

  it('clamps windows to the document', () => {
    const cache = new HighlightCache();
    const result = cache.window(arrayLineSource(lines), getLanguage('javascript'), 3, 99);
    expect([...result.keys()]).toEqual([3, 4]);
  });
});
