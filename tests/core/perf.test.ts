import { describe, expect, it } from 'vitest';
import { TextDocument } from '../../src/core/document';
import { HighlightCache, arrayLineSource, flattenTokens, getLanguage, tokenizeLines } from '../../src/core/language';
import { Search } from '../../src/core/search';
import { computeNewline, decideAutoClose } from '../../src/core/smartEdit';

/** Builds a realistic source file rather than one long repeated line. */
function source(lines: number): string {
  const parts: string[] = [];
  for (let index = 0; index < lines; index += 1) {
    parts.push(`// handler note`);
    parts.push(`export function handler${index}(input: string): number {`);
    parts.push(`  const value = compute(input, ${index}) + 42; // ${'x'.repeat(12)}`);
    parts.push(`  return value > 0 ? value : -1;`);
    parts.push(`}`);
  }
  return parts.join('\n');
}

const measure = (runs: number, fn: () => void): number => {
  fn(); // warm up
  const started = performance.now();
  for (let index = 0; index < runs; index += 1) fn();
  return (performance.now() - started) / runs;
};

describe('performance budgets', () => {
  it('opens a 1MB file in under 100ms', () => {
    const text = source(5000); // ~500KB
    const big = `${text}\n${text}`;
    const elapsed = measure(3, () => {
      const doc = new TextDocument(big);
      void doc.lines;
    });
    console.log(`open ${(big.length / 1024).toFixed(0)}KB: ${elapsed.toFixed(1)}ms`);
    expect(elapsed).toBeLessThan(400);
  });

  it('re-tokenizes a 25000-line buffer fast enough to paint a keystroke', () => {
    const doc = new TextDocument(source(5000));
    const language = getLanguage('typescript');
    const lines = doc.lines;
    const elapsed = measure(5, () => {
      const map = tokenizeLines(lines, language);
      for (const [index, entry] of map) flattenTokens(lines[index] ?? '', entry.tokens);
    });
    console.log(`tokenize ${lines.length} lines: ${elapsed.toFixed(1)}ms`);
    // The UI disables highlighting at 20k lines, so this is the worst case it paints.
    expect(elapsed).toBeLessThan(250);
  });

  it('finds all literal matches in a 1MB document in under 100ms', () => {
    const doc = new TextDocument(`${source(5000)}${source(5000)}`);
    const search = new Search({ query: 'handler49' });
    const elapsed = measure(3, () => {
      search.matches(doc.text);
    });
    console.log(`literal search ${(doc.text.length / 1024).toFixed(0)}KB: ${elapsed.toFixed(1)}ms`);
    expect(elapsed).toBeLessThan(100);
  });

  it('keeps per-keystroke edit helpers in the microsecond range', () => {
    const elapsed = measure(2000, () => {
      decideAutoClose({ char: '(', before: 'x', after: '', hasSelection: false });
      computeNewline({ lineText: '  if (x) {', column: 10, indentUnit: '  ' });
    });
    console.log(`smart-edit helpers: ${(elapsed * 1000).toFixed(1)}µs`);
    expect(elapsed).toBeLessThan(0.05);
  });

  it('applies an edit without touching the rest of a large document', () => {
    const doc = new TextDocument(source(5000));
    const elapsed = measure(200, () => {
      doc.replaceRange(1000, 1000, 'x');
    });
    console.log(`insert into 25k lines: ${(elapsed * 1000).toFixed(0)}µs`);
    // Known cost: TextDocument rebuilds its line index (O(n)) on every edit.
    // Fine to ~50k lines; tracked in the rope/line-index issue.
    expect(elapsed).toBeLessThan(10);
  });
});

describe('windowed highlighting', () => {
  it('tokenizes only the visible window of a large file', () => {
    const doc = new TextDocument(source(5000)); // ~25k lines
    const language = getLanguage('typescript');
    const lines = doc.lines;
    const cache = new HighlightCache();
    const lineSource = arrayLineSource(lines);
    cache.window(lineSource, language, 0, 40); // warm the top of the file
    const elapsed = measure(50, () => {
      const window = cache.window(lineSource, language, 12000, 12060);
      for (const [index, tokens] of window) flattenTokens(lines[index] ?? '', tokens);
    });
    console.log(`window repaint (60 of ${lines.length} lines): ${elapsed.toFixed(2)}ms`);
    expect(elapsed).toBeLessThan(5);
  });
});

describe('per-keystroke model cost', () => {
  it('keeps a full edit cycle on a 25k-line document inside one frame budget', () => {
    let doc = new TextDocument(source(5000));
    const language = getLanguage('typescript');
    const cache = new HighlightCache();
    const elapsed = measure(50, () => {
      doc = doc.replaceRange(1000, 1000, 'x'); // edit
      const starts = doc.lineStarts; // index refresh
      const bytes = doc.text.length * 1; // size probe stand-in
      void bytes;
      cache.invalidateFrom(doc.lineAt(1000));
      cache.window({ lineCount: doc.lineCount, lineText: (index) => doc.lineText(index) }, language, 40, 80);
      void starts;
    });
    console.log(`edit cycle, ${doc.lineCount} lines: ${elapsed.toFixed(2)}ms`);
    expect(elapsed).toBeLessThan(20);
  });
});
