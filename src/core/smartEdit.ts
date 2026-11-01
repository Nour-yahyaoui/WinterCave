/**
 * The "helpful" editing features — the ones most likely to get in the way.
 * Every rule here has a matching undo path and is tested against the annoying
 * case, not the happy case.
 */

export const PAIRS: Readonly<Record<string, string>> = {
  '(': ')',
  '[': ']',
  '{': '}',
  '"': '"',
  "'": "'",
  '`': '`',
};

export const CLOSERS = new Set(Object.values(PAIRS));
export const OPENERS = new Set(Object.keys(PAIRS));

export type AutoCloseAction =
  | { type: 'insert'; text: string }
  | { type: 'skip'; advance: number }
  | { type: 'wrap'; open: string; close: string };

function isWordChar(char: string | undefined): boolean {
  return char !== undefined && /[\p{L}\p{N}_$]/u.test(char);
}

function matchingCloser(open: string): string | undefined {
  return PAIRS[open];
}

/**
 * Decide what a single typed character should do.
 *
 * - Typing a closer when the same character is already next to the caret
 *   steps over it instead of doubling it.
 * - Typing an opener around a selection wraps the selection.
 * - Quotes are conservative near word characters, so prose apostrophes and
 *   `don't` don't turn into `don't'`.
 */
export function decideAutoClose(context: {
  char: string;
  before: string;
  after: string;
  hasSelection: boolean;
}): AutoCloseAction | null {
  const { char, before, after, hasSelection } = context;
  if (hasSelection) {
    const close = matchingCloser(char);
    if (close) return { type: 'wrap', open: char, close };
    return null;
  }

  if (CLOSERS.has(char) && after === char) {
    return { type: 'skip', advance: 1 };
  }

  const isQuote = char === '"' || char === "'" || char === '`';
  if (isQuote) {
    if (isWordChar(before) || after === char || isWordChar(after)) return null;
  }

  const close = matchingCloser(char);
  if (!close) return null;
  if (after !== undefined && after !== '' && !/\s/.test(after) && !CLOSERS.has(after)) return null;
  return { type: 'insert', text: char + close };
}

export interface NewlineContext {
  lineText: string;
  column: number;
  indentUnit: string;
}

export interface NewlineResult {
  /** Text to insert in place of the newline keystroke. */
  text: string;
  /** Caret offset relative to the start of `text`. */
  caret: number;
}

export function leadingWhitespace(lineText: string): string {
  return /^[ \t]*/.exec(lineText)?.[0] ?? '';
}

/** Enter: keep indentation, open a block on `{`, and split `{|}` into three lines. */
export function computeNewline(context: NewlineContext): NewlineResult {
  const { lineText, column, indentUnit } = context;
  const indent = leadingWhitespace(lineText);
  const before = lineText[column - 1];
  const after = lineText[column];

  if (before !== undefined && OPENERS.has(before) && after !== undefined && CLOSERS.has(after) && PAIRS[before] === after) {
    const inner = `\n${indent}${indentUnit}`;
    const text = `${inner}\n${indent}`;
    return { text, caret: inner.length };
  }

  if (before !== undefined && OPENERS.has(before)) {
    const text = `\n${indent}${indentUnit}`;
    return { text, caret: text.length };
  }

  if (after !== undefined && CLOSERS.has(after) && /^[ \t]*$/.test(lineText.slice(0, column))) {
    const dedented = indent.slice(0, Math.max(0, indent.length - indentUnit.length));
    const text = `\n${dedented}`;
    return { text, caret: text.length };
  }

  const text = `\n${indent}`;
  return { text, caret: text.length };
}

/** Home key: first non-blank character first, column 0 on the second press. */
export function smartHomeTarget(lineText: string, column: number): number {
  const firstNonBlank = /^[ \t]*/.exec(lineText)?.[0].length ?? 0;
  if (column === firstNonBlank) return 0;
  return firstNonBlank;
}

export interface IndentOptions {
  indentUnit: string;
  insertSpaces: boolean;
}

/** Detect the file's own convention so we don't fight it. */
export function detectIndent(text: string, fallback: IndentOptions = { indentUnit: '  ', insertSpaces: true }): IndentOptions {
  let tabs = 0;
  let spaces = 0;
  let smallestSpaceRun = Number.POSITIVE_INFINITY;
  for (const line of text.split('\n').slice(0, 2000)) {
    if (line.startsWith('\t')) tabs += 1;
    const run = /^ +/.exec(line)?.[0].length ?? 0;
    if (run > 0) {
      spaces += 1;
      smallestSpaceRun = Math.min(smallestSpaceRun, run);
    }
  }
  if (tabs > spaces) return { indentUnit: '\t', insertSpaces: false };
  if (spaces === 0) return fallback;
  const width = Number.isFinite(smallestSpaceRun) ? Math.min(smallestSpaceRun, 8) : 2;
  return { indentUnit: ' '.repeat(width), insertSpaces: true };
}

export function indentText(text: string, options: IndentOptions): string {
  return text + options.indentUnit;
}

/** Add or remove one indent level from a multi-line block. */
export function reindentBlock(
  lines: readonly string[],
  options: IndentOptions,
  direction: 'indent' | 'outdent',
): string[] {
  return lines.map((line) => {
    if (direction === 'indent') return options.insertSpaces || !line.startsWith('\t') ? options.indentUnit + line : '\t' + line;
    if (options.indentUnit === '\t') return line.startsWith('\t') ? line.slice(1) : line.replace(/^ {1,4}/, '');
    let remove = options.indentUnit.length;
    let index = 0;
    while (index < line.length && remove > 0 && line[index] === ' ') {
      index += 1;
      remove -= 1;
    }
    return line.slice(index);
  });
}

export function toggleLineCommentText(line: string, prefix: string | undefined): string {
  if (!prefix) return line;
  if (line.trim().length === 0) return line;
  const indent = leadingWhitespace(line);
  const rest = line.slice(indent.length);
  if (rest.startsWith(`${prefix} `)) return indent + rest.slice(prefix.length + 1);
  if (rest.startsWith(prefix)) return indent + rest.slice(prefix.length);
  return `${indent}${prefix} ${rest}`;
}

/** Comment every non-blank line, or uncomment them all if they're already commented. */
export function toggleCommentBlock(lines: readonly string[], prefix: string | undefined): string[] {
  if (!prefix) return [...lines];
  const meaningful = lines.filter((line) => line.trim().length > 0);
  if (meaningful.length === 0) return [...lines];
  const allCommented = meaningful.every((line) => line.trimStart().startsWith(prefix));
  if (allCommented) {
    return lines.map((line) => {
      if (line.trim().length === 0) return line;
      const indent = leadingWhitespace(line);
      let rest = line.slice(indent.length);
      rest = rest.slice(prefix.length);
      if (rest.startsWith(' ')) rest = rest.slice(1);
      return indent + rest;
    });
  }
  return lines.map((line) => {
    if (line.trim().length === 0) return line;
    const indent = leadingWhitespace(line);
    return `${indent}${prefix} ${line.slice(indent.length)}`;
  });
}
