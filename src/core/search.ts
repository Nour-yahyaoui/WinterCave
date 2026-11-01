export interface SearchOptions {
  query: string;
  caseSensitive?: boolean;
  wholeWord?: boolean;
  regex?: boolean;
}

export interface SearchMatch {
  from: number;
  to: number;
}

export const MAX_MATCHES = 20000;

export function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isWordChar(char: string | undefined): boolean {
  if (char === undefined) return false;
  return /[\p{L}\p{N}_$]/u.test(char);
}

/** Expand `$&`, `$1`, `$<name>`, `` $` ``, `$'` and `$$` like `String.replace`. */
export function expandReplacement(template: string, match: RegExpExecArray): string {
  return template.replace(/\$(\$|&|["'`]|\d{1,2}|<[^>]*>)/g, (whole, token: string) => {
    if (token === '$') return '$';
    if (token === '&') return match[0];
    if (token === '`') return match.input.slice(0, match.index);
    if (token === "'") return match.input.slice(match.index + match[0].length);
    if (token.startsWith('<')) {
      const value = match.groups?.[token.slice(1, -1)];
      return value ?? '';
    }
    const index = Number(token);
    if (!Number.isFinite(index)) return whole;
    const direct = match[index];
    if (direct !== undefined) return direct;
    if (token.length === 2) {
      // `$10` with fewer than 10 groups means group 1 followed by a literal 0.
      const first = match[Number(token[0])];
      if (first !== undefined) return first + token.slice(1);
    }
    return '';
  });
}

/**
 * Compiled search: literal or regex, optional case sensitivity and whole-word.
 * Invalid patterns surface as `error` instead of throwing at the UI layer.
 */
export class Search {
  readonly options: Required<SearchOptions>;
  readonly error: string | null;
  private readonly regex: RegExp | null;

  constructor(options: SearchOptions) {
    this.options = {
      query: options.query,
      caseSensitive: options.caseSensitive ?? false,
      wholeWord: options.wholeWord ?? false,
      regex: options.regex ?? false,
    };

    let regex: RegExp | null = null;
    let error: string | null = null;
    if (this.options.query.length > 0) {
      const source = this.options.regex ? this.options.query : escapeRegExp(this.options.query);
      try {
        regex = new RegExp(source, this.options.caseSensitive ? 'g' : 'gi');
      } catch (cause) {
        error = cause instanceof Error ? cause.message : 'Invalid pattern';
      }
    }
    this.regex = regex;
    this.error = error;
  }

  get isEmpty(): boolean {
    return this.options.query.length === 0;
  }

  get isValid(): boolean {
    return this.regex !== null && this.error === null;
  }

  private visit(
    text: string,
    onMatch: (match: SearchMatch, raw: RegExpExecArray) => boolean,
  ): void {
    const regex = this.regex;
    if (!regex) return;
    regex.lastIndex = 0;
    let guard = 0;
    let found = regex.exec(text);
    while (found !== null && guard < MAX_MATCHES * 4) {
      guard += 1;
      const from = found.index;
      const to = from + found[0].length;
      const zeroLength = found[0].length === 0;
      const wholeWordOk =
        !this.options.wholeWord ||
        zeroLength ||
        (!isWordChar(text[from - 1]) && !isWordChar(text[to]));
      if (wholeWordOk && !onMatch({ from, to }, found)) return;
      // A zero-length pattern would otherwise match forever at the same offset.
      if (zeroLength) regex.lastIndex = from + 1;
      found = regex.exec(text);
    }
  }

  matches(text: string, limit: number = MAX_MATCHES): SearchMatch[] {
    const result: SearchMatch[] = [];
    this.visit(text, (match) => {
      result.push(match);
      return result.length < limit;
    });
    return result;
  }

  replaceAll(text: string, replacement: string): { text: string; count: number } {
    const pieces: string[] = [];
    let cursor = 0;
    let count = 0;
    this.visit(text, (match, raw) => {
      pieces.push(text.slice(cursor, match.from));
      pieces.push(this.options.regex ? expandReplacement(replacement, raw) : replacement);
      cursor = match.to;
      count += 1;
      return true;
    });
    if (count === 0) return { text, count: 0 };
    pieces.push(text.slice(cursor));
    return { text: pieces.join(''), count };
  }

  /** Index of the next/previous match relative to a caret offset, wrapping. */
  nextIndex(matches: readonly SearchMatch[], offset: number, direction: 'forward' | 'backward'): number {
    if (matches.length === 0) return -1;
    if (direction === 'forward') {
      const found = matches.findIndex((match) => match.from > offset);
      return found === -1 ? 0 : found;
    }
    for (let i = matches.length - 1; i >= 0; i -= 1) {
      const match = matches[i];
      if (match && match.to <= offset) return i;
    }
    return matches.length - 1;
  }
}
