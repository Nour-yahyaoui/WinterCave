import { describe, expect, it } from 'vitest';
import { TextDocument } from '../../src/core/document';

describe('TextDocument', () => {
  it('exposes lines, starts and terminators', () => {
    const doc = new TextDocument('alpha\nbeta\ngamma');
    expect(doc.lineCount).toBe(3);
    expect(doc.lineStarts).toEqual([0, 6, 11]);
    expect(doc.lines).toEqual(['alpha', 'beta', 'gamma']);
    expect(doc.lineRange(1)).toEqual({ start: 6, end: 10 });
    expect(doc.lineText(2)).toBe('gamma');
  });

  it('represents a trailing newline as an empty final line', () => {
    const doc = new TextDocument('a\n');
    expect(doc.lineCount).toBe(2);
    expect(doc.lines).toEqual(['a', '']);
    expect(doc.lineRange(0)).toEqual({ start: 0, end: 1 });
  });

  it('treats an empty document as one empty line', () => {
    const doc = TextDocument.empty();
    expect(doc.lineCount).toBe(1);
    expect(doc.lines).toEqual(['']);
    expect(doc.positionAt(0)).toEqual({ line: 0, column: 0 });
  });

  it('maps offsets to positions and back', () => {
    const doc = new TextDocument('one\ntwo\nthree');
    for (let offset = 0; offset <= doc.length; offset += 1) {
      const position = doc.positionAt(offset);
      expect(doc.offsetAt(position)).toBe(offset);
    }
    expect(doc.positionAt(4)).toEqual({ line: 1, column: 0 });
    expect(doc.positionAt(13)).toEqual({ line: 2, column: 5 });
    expect(doc.lineAt(7)).toBe(1);
    expect(doc.lineAt(8)).toBe(2);
  });

  it('clamps out-of-range positions', () => {
    const doc = new TextDocument('abc\ndef');
    expect(doc.offsetAt({ line: 0, column: 99 })).toBe(3);
    expect(doc.offsetAt({ line: 99, column: 0 })).toBe(4);
    expect(doc.offsetAt({ line: -3, column: -3 })).toBe(0);
    expect(doc.lineText(99)).toBe('');
  });

  it('is immutable across edits', () => {
    const original = new TextDocument('hello');
    const inserted = original.insert(0, '> ');
    expect(original.text).toBe('hello');
    expect(inserted.text).toBe('> hello');
    expect(inserted.remove(0, 2).text).toBe('hello');
    expect(inserted.replaceRange(2, 7, 'bye').text).toBe('> bye');
  });

  it('normalises CRLF on the way in and restores it on the way out', () => {
    const doc = new TextDocument('a\r\nb\r\nc');
    expect(doc.text).toBe('a\nb\nc');
    expect(doc.eol).toBe('\r\n');
    expect(doc.getText()).toBe('a\r\nb\r\nc');
    expect(doc.insert(0, 'x\ny').getText()).toBe('x\r\nya\r\nb\r\nc');
  });

  it('keeps the newline convention when editing a file without a trailing newline', () => {
    const doc = new TextDocument('# notes');
    const edited = doc.replaceRange(doc.length, doc.length, '\nsecond line');
    expect(edited.getText()).toBe('# notes\nsecond line');
    expect(edited.eol).toBe('\n');
  });

  it('swallows inverted ranges', () => {
    const doc = new TextDocument('abcdef');
    expect(doc.remove(4, 2).text).toBe('abef');
    expect(doc.replaceRange(4, 2, 'X').text).toBe('abXef');
  });

  it('compares by content and line ending', () => {
    expect(new TextDocument('a\nb').equals(new TextDocument('a\nb'))).toBe(true);
    expect(new TextDocument('a\nb').equals(new TextDocument('a\nb '))).toBe(false);
  });
});
