import {
  clamp,
  detectLineEnding,
  normalizeNewlines,
  restoreLineEnding,
  type LineEnding,
} from './text';

export interface TextPosition {
  /** 0-based line index. */
  line: number;
  /** 0-based UTF-16 column. */
  column: number;
}

export interface LineRange {
  /** Offset of the first character of the line. */
  start: number;
  /** Offset of the line terminator (or end of document). */
  end: number;
}

function computeLineStarts(text: string): number[] {
  const starts: number[] = [0];
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) starts.push(i + 1);
  }
  return starts;
}

/**
 * Immutable text document. Every mutation returns a new instance, which keeps
 * undo, recovery snapshots and tests honest: a document reference never
 * silently changes under you.
 *
 * Internally newlines are normalised to LF; `eol` remembers what the file used
 * so `getText()` can put it back on save.
 */
export class TextDocument {
  readonly text: string;
  readonly eol: LineEnding;
  private readonly starts: readonly number[];

  constructor(text: string, eol?: LineEnding) {
    const normalized = normalizeNewlines(text);
    this.text = normalized;
    this.eol = eol ?? detectLineEnding(text);
    this.starts = computeLineStarts(normalized);
  }

  static empty(): TextDocument {
    return new TextDocument('');
  }

  get length(): number {
    return this.text.length;
  }

  get lineCount(): number {
    return this.starts.length;
  }

  get lineStarts(): readonly number[] {
    return this.starts;
  }

  /** Text of a single line, without its terminator. Out-of-range lines are ''. */
  lineText(line: number): string {
    if (line < 0 || line >= this.starts.length) return '';
    return this.text.slice(this.starts[line], this.lineEnd(line));
  }

  lineEnd(line: number): number {
    if (line < 0 || line >= this.starts.length) return this.text.length;
    return line + 1 < this.starts.length ? this.starts[line + 1] - 1 : this.text.length;
  }

  lineRange(line: number): LineRange {
    const clamped = clamp(line, 0, this.starts.length - 1);
    return { start: this.starts[clamped], end: this.lineEnd(clamped) };
  }

  offsetAt(position: TextPosition): number {
    const line = clamp(position.line, 0, this.starts.length - 1);
    const start = this.starts[line];
    const end = this.lineEnd(line);
    return clamp(start + Math.max(0, position.column), start, end);
  }

  /** Line index containing `offset`. */
  lineAt(offset: number): number {
    const at = clamp(offset, 0, this.text.length);
    let low = 0;
    let high = this.starts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (this.starts[mid] <= at) low = mid;
      else high = mid - 1;
    }
    return low;
  }

  positionAt(offset: number): TextPosition {
    const at = clamp(offset, 0, this.text.length);
    const line = this.lineAt(at);
    return { line, column: at - this.starts[line] };
  }

  lineTextAt(offset: number): string {
    return this.lineText(this.lineAt(offset));
  }

  /** New document with the same newline convention. */
  withText(text: string): TextDocument {
    return new TextDocument(text, this.eol);
  }

  insert(offset: number, insertText: string): TextDocument {
    const at = clamp(offset, 0, this.text.length);
    return this.withText(this.text.slice(0, at) + normalizeNewlines(insertText) + this.text.slice(at));
  }

  remove(from: number, to: number): TextDocument {
    const start = clamp(Math.min(from, to), 0, this.text.length);
    const end = clamp(Math.max(from, to), 0, this.text.length);
    return this.withText(this.text.slice(0, start) + this.text.slice(end));
  }

  replaceRange(from: number, to: number, replacement: string): TextDocument {
    const start = clamp(Math.min(from, to), 0, this.text.length);
    const end = clamp(Math.max(from, to), 0, this.text.length);
    return this.withText(
      this.text.slice(0, start) + normalizeNewlines(replacement) + this.text.slice(end),
    );
  }

  /** Full text as it should be written to disk (original line endings). */
  getText(): string {
    return restoreLineEnding(this.text, this.eol);
  }

  get lines(): string[] {
    const result: string[] = [];
    for (let i = 0; i < this.starts.length; i += 1) result.push(this.lineText(i));
    return result;
  }

  equals(other: TextDocument): boolean {
    return this.text === other.text && this.eol === other.eol;
  }
}
