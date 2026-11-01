export type TokenType =
  | 'keyword'
  | 'string'
  | 'comment'
  | 'number'
  | 'constant'
  | 'function'
  | 'type'
  | 'tag'
  | 'attribute'
  | 'operator'
  | 'heading'
  | 'emphasis'
  | 'strong'
  | 'link'
  | 'code'
  | 'list'
  | 'meta';

export interface Token {
  start: number;
  end: number;
  type: TokenType;
}

export interface HighlightState {
  /** Closing delimiter of an open block comment. */
  blockComment: string | null;
  /** Delimiter of an open multi-line string. */
  string: string | null;
  /** Inside a Markdown fenced code block. */
  fence: boolean;
}

export const EMPTY_HIGHLIGHT_STATE: HighlightState = {
  blockComment: null,
  string: null,
  fence: false,
};

export type LanguageFamily = 'plain' | 'code' | 'markup' | 'markdown' | 'style';

export interface LanguageDef {
  id: string;
  name: string;
  extensions: string[];
  family: LanguageFamily;
  keywords: readonly string[];
  constants?: readonly string[];
  lineComment?: string;
  blockComment?: { open: string; close: string };
  quotes?: readonly string[];
  /** Quote characters whose strings may legally span lines. */
  multilineQuotes?: readonly string[];
  /** Repeating this on a line indents instead of inserting a tab. */
  indentUnit?: string;
  wordWrapDefault?: boolean;
  spellcheckDefault?: boolean;
}

const CODE_QUOTES = ['"', "'", '`'];

const JS_KEYWORDS = [
  'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger',
  'default', 'delete', 'do', 'else', 'enum', 'export', 'extends', 'finally', 'for',
  'from', 'function', 'get', 'if', 'implements', 'import', 'in', 'instanceof',
  'interface', 'let', 'new', 'of', 'return', 'set', 'static', 'super', 'switch',
  'this', 'throw', 'try', 'type', 'typeof', 'var', 'void', 'while', 'with', 'yield',
];

const TS_KEYWORDS = [
  ...JS_KEYWORDS,
  'abstract', 'as', 'asserts', 'declare', 'is', 'keyof', 'namespace', 'never',
  'readonly', 'satisfies', 'unknown', 'override', 'infer', 'module',
];

const PYTHON_KEYWORDS = [
  'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def', 'del',
  'elif', 'else', 'except', 'finally', 'for', 'from', 'global', 'if', 'import', 'in',
  'is', 'lambda', 'match', 'case', 'nonlocal', 'not', 'or', 'pass', 'raise', 'return',
  'try', 'while', 'with', 'yield',
];

const SHELL_KEYWORDS = [
  'if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'until', 'do', 'done', 'case',
  'esac', 'function', 'return', 'in', 'select', 'time', 'export', 'local', 'readonly',
  'source', 'alias', 'unset', 'set', 'shift', 'trap', 'eval', 'exec', 'exit',
];

const SQL_KEYWORDS = [
  'select', 'from', 'where', 'insert', 'into', 'values', 'update', 'set', 'delete',
  'create', 'table', 'alter', 'drop', 'index', 'view', 'join', 'left', 'right',
  'inner', 'outer', 'full', 'on', 'group', 'by', 'order', 'having', 'limit',
  'offset', 'union', 'all', 'distinct', 'as', 'and', 'or', 'not', 'null', 'case',
  'when', 'then', 'else', 'end', 'primary', 'foreign', 'key', 'references',
];

export const LANGUAGES: readonly LanguageDef[] = [
  {
    id: 'plaintext',
    name: 'Plain Text',
    extensions: ['txt', 'log', 'text', ''],
    family: 'plain',
    keywords: [],
    wordWrapDefault: true,
    spellcheckDefault: true,
    indentUnit: '  ',
  },
  {
    id: 'markdown',
    name: 'Markdown',
    extensions: ['md', 'markdown', 'mdx'],
    family: 'markdown',
    keywords: [],
    wordWrapDefault: true,
    spellcheckDefault: true,
    indentUnit: '  ',
  },
  {
    id: 'javascript',
    name: 'JavaScript',
    extensions: ['js', 'mjs', 'cjs', 'jsx'],
    family: 'code',
    keywords: JS_KEYWORDS,
    constants: ['true', 'false', 'null', 'undefined', 'NaN', 'Infinity'],
    lineComment: '//',
    blockComment: { open: '/*', close: '*/' },
    quotes: CODE_QUOTES,
    multilineQuotes: ['`'],
    indentUnit: '  ',
  },
  {
    id: 'typescript',
    name: 'TypeScript',
    extensions: ['ts', 'tsx', 'mts', 'cts'],
    family: 'code',
    keywords: TS_KEYWORDS,
    constants: ['true', 'false', 'null', 'undefined', 'NaN', 'Infinity'],
    lineComment: '//',
    blockComment: { open: '/*', close: '*/' },
    quotes: CODE_QUOTES,
    multilineQuotes: ['`'],
    indentUnit: '  ',
  },
  {
    id: 'json',
    name: 'JSON',
    extensions: ['json', 'jsonc', 'webmanifest'],
    family: 'code',
    keywords: [],
    constants: ['true', 'false', 'null'],
    quotes: ['"'],
    indentUnit: '  ',
  },
  {
    id: 'html',
    name: 'HTML',
    extensions: ['html', 'htm', 'xml', 'svg', 'vue', 'svelte'],
    family: 'markup',
    keywords: [],
    quotes: ['"', "'"],
    blockComment: { open: '<!--', close: '-->' },
    indentUnit: '  ',
  },
  {
    id: 'css',
    name: 'CSS',
    extensions: ['css', 'scss', 'less'],
    family: 'style',
    keywords: ['@media', '@import', '@font-face', '@keyframes', '@supports', '@layer'],
    blockComment: { open: '/*', close: '*/' },
    quotes: ['"', "'"],
    indentUnit: '  ',
  },
  {
    id: 'python',
    name: 'Python',
    extensions: ['py', 'pyw', 'pyi'],
    family: 'code',
    keywords: PYTHON_KEYWORDS,
    constants: ['True', 'False', 'None', 'self', 'cls'],
    lineComment: '#',
    quotes: ['"', "'"],
    indentUnit: '    ',
  },
  {
    id: 'shell',
    name: 'Shell',
    extensions: ['sh', 'bash', 'zsh', 'fish', 'env'],
    family: 'code',
    keywords: SHELL_KEYWORDS,
    lineComment: '#',
    quotes: ['"', "'"],
    indentUnit: '  ',
  },
  {
    id: 'yaml',
    name: 'YAML',
    extensions: ['yml', 'yaml'],
    family: 'code',
    keywords: [],
    constants: ['true', 'false', 'null', '~', 'yes', 'no'],
    lineComment: '#',
    quotes: ['"', "'"],
    indentUnit: '  ',
  },
  {
    id: 'sql',
    name: 'SQL',
    extensions: ['sql'],
    family: 'code',
    keywords: SQL_KEYWORDS,
    constants: ['null', 'true', 'false'],
    lineComment: '--',
    blockComment: { open: '/*', close: '*/' },
    quotes: ["'", '"'],
    indentUnit: '  ',
  },
];

const LANGUAGE_BY_ID = new Map(LANGUAGES.map((language) => [language.id, language]));

export function getLanguage(id: string): LanguageDef {
  return LANGUAGE_BY_ID.get(id) ?? LANGUAGES[0]!;
}

export function languageForFilename(filename: string): LanguageDef {
  const match = /\.([^.\\/]+)$/.exec(filename);
  const extension = (match?.[1] ?? '').toLowerCase();
  if (extension === '') return LANGUAGES[0]!;
  return LANGUAGES.find((language) => language.extensions.includes(extension)) ?? LANGUAGES[0]!;
}

function isIdentifierStart(char: string): boolean {
  return /[A-Za-z_$@#]/.test(char);
}

function isIdentifierPart(char: string): boolean {
  return /[A-Za-z0-9_$]/.test(char);
}

function tokenizeCodeLine(
  line: string,
  language: LanguageDef,
  state: HighlightState,
): { tokens: Token[]; state: HighlightState } {
  const tokens: Token[] = [];
  const keywords = new Set(language.keywords);
  const constants = new Set(language.constants ?? []);
  const query = new Set(language.quotes ?? CODE_QUOTES);
  const multiline = new Set(language.multilineQuotes ?? []);
  let next: HighlightState = { ...state };
  let i = 0;

  const push = (start: number, end: number, type: TokenType) => {
    if (end > start) tokens.push({ start, end, type });
  };

  while (i < line.length) {
    // Finish an open block comment.
    if (next.blockComment) {
      const close = next.blockComment;
      const found = line.indexOf(close, i);
      if (found === -1) {
        push(i, line.length, 'comment');
        return { tokens, state: next };
      }
      push(i, found + close.length, 'comment');
      i = found + close.length;
      next = { ...next, blockComment: null };
      continue;
    }

    // Finish an open multi-line string.
    if (next.string) {
      const quote = next.string;
      let j = i;
      let closed = false;
      while (j < line.length) {
        if (line[j] === '\\') {
          j += 2;
          continue;
        }
        if (line[j] === quote) {
          j += 1;
          closed = true;
          break;
        }
        j += 1;
      }
      push(i, Math.min(j, line.length), 'string');
      i = Math.min(j, line.length);
      next = closed ? { ...next, string: null } : next;
      continue;
    }

    const char = line[i] ?? '';

    if (language.lineComment && line.startsWith(language.lineComment, i)) {
      push(i, line.length, 'comment');
      break;
    }

    if (language.blockComment && line.startsWith(language.blockComment.open, i)) {
      next = { ...next, blockComment: language.blockComment.close };
      continue;
    }

    if (query.has(char)) {
      let j = i + 1;
      let closed = false;
      while (j < line.length) {
        if (line[j] === '\\') {
          j += 2;
          continue;
        }
        if (line[j] === char) {
          j += 1;
          closed = true;
          break;
        }
        j += 1;
      }
      const end = Math.min(j, line.length);
      push(i, end, 'string');
      if (!closed && multiline.has(char)) next = { ...next, string: char };
      i = end;
      continue;
    }

    if (/[0-9]/.test(char) && (i === 0 || !isIdentifierPart(line[i - 1] ?? ''))) {
      const match = /^(?:0[xX][0-9a-fA-F_]+|0[bB][01_]+|\d[\d_]*(?:\.[\d_]+)?(?:[eE][+-]?\d+)?)([a-zA-Z%]*)/.exec(
        line.slice(i),
      );
      if (match) {
        push(i, i + match[0].length, 'number');
        i += match[0].length;
        continue;
      }
    }

    if (isIdentifierStart(char)) {
      let j = i + 1;
      while (j < line.length && isIdentifierPart(line[j] ?? '')) j += 1;
      const word = line.slice(i, j);
      let type: TokenType | null = null;
      if (keywords.has(word) || keywords.has(word.toLowerCase()) && language.id === 'sql') type = 'keyword';
      else if (constants.has(word)) type = 'constant';
      else if ((line[j] ?? '') === '(') type = 'function';
      else if (/^[A-Z]/.test(word)) type = 'type';
      if (type) push(i, j, type);
      i = j;
      continue;
    }

    if (/[=+\-*/%<>!&|^~?:]/.test(char)) {
      let j = i + 1;
      while (j < line.length && /[=+\-*/%<>!&|^~?:]/.test(line[j] ?? '')) j += 1;
      push(i, j, 'operator');
      i = j;
      continue;
    }

    i += 1;
  }

  return { tokens, state: next };
}

function tokenizeStyleLine(
  line: string,
  language: LanguageDef,
  state: HighlightState,
): { tokens: Token[]; state: HighlightState } {
  const base = tokenizeCodeLine(line, language, state);
  const tokens = [...base.tokens];
  // `property:` and `.selector` read better than plain text.
  const property = /(^|[{;\s])([-a-zA-Z]+)(\s*:)/g;
  let found = property.exec(line);
  while (found) {
    const start = found.index + (found[1]?.length ?? 0);
    tokens.push({ start, end: start + found[2]!.length, type: 'attribute' });
    found = property.exec(line);
  }
  const selector = /(^|\})\s*([.#][-\w]+)/g;
  found = selector.exec(line);
  while (found) {
    const start = found.index + (found[1]?.length ?? 0);
    tokens.push({ start, end: start + found[2]!.length, type: 'tag' });
    found = selector.exec(line);
  }
  tokens.sort((a, b) => a.start - b.start || a.end - b.end);
  return { tokens, state: base.state };
}

function tokenizeMarkupLine(
  line: string,
  language: LanguageDef,
  state: HighlightState,
): { tokens: Token[]; state: HighlightState } {
  const tokens: Token[] = [];
  let next: HighlightState = { ...state };
  let i = 0;
  const push = (start: number, end: number, type: TokenType) => {
    if (end > start) tokens.push({ start, end, type });
  };

  while (i < line.length) {
    if (next.blockComment) {
      const close = next.blockComment;
      const found = line.indexOf(close, i);
      if (found === -1) {
        push(i, line.length, 'comment');
        return { tokens, state: next };
      }
      push(i, found + close.length, 'comment');
      i = found + close.length;
      next = { ...next, blockComment: null };
      continue;
    }
    if (language.blockComment && line.startsWith(language.blockComment.open, i)) {
      next = { ...next, blockComment: language.blockComment.close };
      continue;
    }
    if (line[i] === '<') {
      const close = line.indexOf('>', i);
      const end = close === -1 ? line.length : close + 1;
      push(i, end, 'tag');
      // Attribute names and their quoted values inside the tag.
      const inner = line.slice(i, end);
      const attribute = /([-\w:]+)(\s*=\s*)("[^"]*"|'[^']*')?/g;
      let found = attribute.exec(inner);
      while (found) {
        const nameStart = i + found.index;
        push(nameStart, nameStart + found[1]!.length, 'attribute');
        if (found[3]) {
          const valueStart = nameStart + found[1]!.length + found[2]!.length;
          push(valueStart, valueStart + found[3].length, 'string');
        }
        found = attribute.exec(inner);
      }
      tokens.sort((a, b) => a.start - b.start || a.end - b.end);
      i = end;
      continue;
    }
    i += 1;
  }
  return { tokens, state: next };
}

function tokenizeMarkdownLine(
  line: string,
  _language: LanguageDef,
  state: HighlightState,
): { tokens: Token[]; state: HighlightState } {
  const tokens: Token[] = [];
  const fence = /^\s*(```|~~~)/.exec(line);

  if (state.fence) {
    if (fence) {
      return { tokens: [{ start: 0, end: line.length, type: 'meta' }], state: { ...state, fence: false } };
    }
    return { tokens: [{ start: 0, end: line.length, type: 'code' }], state };
  }
  if (fence) {
    return { tokens: [{ start: 0, end: line.length, type: 'meta' }], state: { ...state, fence: true } };
  }

  const heading = /^\s{0,3}(#{1,6})\s.*$/.exec(line);
  if (heading) {
    return { tokens: [{ start: 0, end: line.length, type: 'heading' }], state };
  }
  if (/^\s{0,3}([-*_])\1{2,}\s*$/.test(line)) {
    return { tokens: [{ start: 0, end: line.length, type: 'meta' }], state };
  }
  if (/^\s*>/.test(line)) {
    tokens.push({ start: 0, end: line.length, type: 'meta' });
  }
  const list = /^(\s*)([-*+]|\d+[.)])\s/.exec(line);
  if (list) {
    const start = list[1]?.length ?? 0;
    tokens.push({ start, end: start + (list[2]?.length ?? 0), type: 'list' });
  }

  const inline = /(`[^`]*`)|(\*\*[^*]+\*\*)|(__[^_]+__)|(\*[^*\n]+\*)|(_[^_\n]+_)|(!?\[[^\]]*\]\([^)]*\))/g;
  let found = inline.exec(line);
  while (found) {
    const start = found.index;
    const text = found[0];
    const type: TokenType = text.startsWith('`')
      ? 'code'
      : text.startsWith('**') || text.startsWith('__')
        ? 'strong'
        : text.startsWith('*') || text.startsWith('_')
          ? 'emphasis'
          : 'link';
    tokens.push({ start, end: start + text.length, type });
    found = inline.exec(line);
  }

  tokens.sort((a, b) => a.start - b.start || b.end - a.end);
  // Remove overlaps produced by the block + inline passes.
  const clean: Token[] = [];
  for (const token of tokens) {
    const last = clean[clean.length - 1];
    if (last && token.start < last.end) {
      if (token.end > last.end) last.end = token.end;
      continue;
    }
    clean.push({ ...token });
  }
  return { tokens: clean, state };
}

/** Tokenize one line, carrying multi-line state (comments, fences) forward. */
export function tokenizeLine(
  line: string,
  language: LanguageDef,
  state: HighlightState,
): { tokens: Token[]; state: HighlightState } {
  switch (language.family) {
    case 'plain':
      return { tokens: [], state: EMPTY_HIGHLIGHT_STATE };
    case 'markdown':
      return tokenizeMarkdownLine(line, language, state);
    case 'markup':
      return tokenizeMarkupLine(line, language, state);
    case 'style':
      return tokenizeStyleLine(line, language, state);
    case 'code':
    default:
      return tokenizeCodeLine(line, language, state);
  }
}

export interface LineSource {
  readonly lineCount: number;
  lineText(index: number): string;
}

export function arrayLineSource(lines: readonly string[]): LineSource {
  return { lineCount: lines.length, lineText: (index: number) => lines[index] ?? '' };
}

export interface TokenizedLine {
  tokens: Token[];
  /** State expected at the start of this line. */
  entryState: HighlightState;
}

/**
 * Tokenize a whole document or a window of it. State is always replayed from
 * line 0 so a block comment opened off-screen is still coloured correctly.
 */
export function tokenizeLines(
  lines: readonly string[],
  language: LanguageDef,
  window: { from: number; to: number } = { from: 0, to: lines.length },
): Map<number, TokenizedLine> {
  const from = Math.max(0, Math.min(window.from, lines.length));
  const to = Math.max(from, Math.min(window.to, lines.length));
  const result = new Map<number, TokenizedLine>();
  let state = EMPTY_HIGHLIGHT_STATE;
  for (let index = 0; index < to; index += 1) {
    const line = lines[index] ?? '';
    const entryState = state;
    const tokenized = tokenizeLine(line, language, state);
    state = tokenized.state;
    if (index >= from) result.set(index, { tokens: tokenized.tokens, entryState });
  }
  return result;
}

/**
 * Collapse layered tokens into non-overlapping runs. Later tokens win, which is
 * what makes `<div class="x">` paint the attribute and its string over the tag.
 */
export function flattenTokens(line: string, tokens: readonly Token[]): Token[] {
  if (tokens.length === 0 || line.length === 0) return [];
  const types: (TokenType | null)[] = new Array(line.length).fill(null);
  for (const token of tokens) {
    const start = Math.max(0, token.start);
    const end = Math.min(line.length, token.end);
    for (let i = start; i < end; i += 1) types[i] = token.type;
  }
  const runs: Token[] = [];
  let runStart = 0;
  for (let i = 1; i <= types.length; i += 1) {
    const current = types[runStart] ?? null;
    const next = i < types.length ? (types[i] ?? null) : undefined;
    if (next !== current) {
      if (current !== null) runs.push({ start: runStart, end: i, type: current });
      runStart = i;
    }
  }
  return runs;
}

/** Lines we are willing to re-tokenize to recover multi-line state. */
const MAX_STATE_REPLAY = 3000;

interface CachedLine {
  entry: HighlightState;
  exit: HighlightState;
  tokens: Token[];
}

function statesEqual(a: HighlightState, b: HighlightState): boolean {
  return a.blockComment === b.blockComment && a.string === b.string && a.fence === b.fence;
}

/**
 * Per-line highlight cache with carried multi-line state.
 *
 * Re-tokenizing a 25k-line buffer on every keystroke costs ~150ms; tokenizing
 * only the visible window costs microseconds. Entries below the first changed
 * line stay valid, so an edit near the caret keeps the rest of the document
 * warm.
 */
export class HighlightCache {
  private entries = new Map<number, CachedLine>();
  private languageId: string | null = null;

  reset(languageId?: string): void {
    this.entries.clear();
    if (languageId !== undefined) this.languageId = languageId;
  }

  /** Drop everything at or below a line that changed. */
  invalidateFrom(line: number): void {
    if (this.entries.size === 0) return;
    for (const index of [...this.entries.keys()]) {
      if (index >= line) this.entries.delete(index);
    }
  }

  get size(): number {
    return this.entries.size;
  }

  /** Tokenized lines for `[from, to)`, reusing whatever is still valid. */
  window(
    source: LineSource,
    language: LanguageDef,
    from: number,
    to: number,
  ): Map<number, Token[]> {
    if (this.languageId !== language.id) this.reset(language.id);
    const start = Math.max(0, Math.min(from, source.lineCount));
    const end = Math.max(start, Math.min(to, source.lineCount));
    const out = new Map<number, Token[]>();

    // Start from the closest line whose exit state we already know. Without one
    // the window must be replayed from the top, otherwise a block comment
    // opened above the viewport would be coloured as code.
    let index = 0;
    let state = EMPTY_HIGHLIGHT_STATE;
    for (let probe = start - 1; probe >= 0; probe -= 1) {
      const cached = this.entries.get(probe);
      if (cached) {
        state = cached.exit;
        index = probe + 1;
        break;
      }
    }
    // Replaying tens of thousands of lines to colour 40 is worse than a
    // slightly wrong colour after a huge jump; cap the replay distance.
    if (start - index > MAX_STATE_REPLAY) {
      index = start;
      state = EMPTY_HIGHLIGHT_STATE;
    }

    for (; index < end; index += 1) {
      const line = source.lineText(index);
      const cached = this.entries.get(index);
      if (cached && statesEqual(cached.entry, state)) {
        if (index >= start) out.set(index, cached.tokens);
        state = cached.exit;
        continue;
      }
      const tokenized = tokenizeLine(line, language, state);
      this.entries.set(index, { entry: state, exit: tokenized.state, tokens: tokenized.tokens });
      if (index >= start) out.set(index, tokenized.tokens);
      state = tokenized.state;
    }

    return out;
  }
}
