export interface FuzzyMatch {
  score: number;
  /** Indices in the target that matched, for highlighting. */
  positions: number[];
}

const BONUS_CONSECUTIVE = 8;
const BONUS_WORD_START = 12;
const BONUS_CAMEL = 6;
const BONUS_EXACT_CASE = 1;
const PENALTY_GAP = 1;
const BASE_MATCH = 4;

function isBoundary(target: string, index: number): boolean {
  if (index === 0) return true;
  const previous = target[index - 1] ?? '';
  const current = target[index] ?? '';
  return /[\s._\-/\\:]/.test(previous) || (/[a-z]/.test(previous) && /[A-Z]/.test(current));
}

/**
 * Subsequence matcher for the command palette and quick open.
 * Not fuzzy in the "typo-tolerant" sense — predictable beats clever.
 */
export function fuzzyMatch(query: string, target: string): FuzzyMatch | null {
  if (query.length === 0) return { score: 0, positions: [] };
  if (query.length > target.length) return null;

  const lowerQuery = query.toLowerCase();
  const lowerTarget = target.toLowerCase();
  const positions: number[] = [];
  let score = 0;
  let targetIndex = 0;
  let previousIndex = -1;

  for (const char of lowerQuery) {
    const found = lowerTarget.indexOf(char, targetIndex);
    if (found === -1) return null;
    score += BASE_MATCH;
    if (found === previousIndex + 1) score += BONUS_CONSECUTIVE;
    else if (previousIndex >= 0) score -= Math.min(PENALTY_GAP * (found - previousIndex - 1), 10);
    if (isBoundary(target, found)) score += BONUS_WORD_START;
    if ((target[found] ?? '') === (query[positions.length] ?? '') && /[A-Z]/.test(target[found] ?? '')) {
      score += BONUS_CAMEL;
    }
    if (target[found] === query[positions.length]) score += BONUS_EXACT_CASE;
    positions.push(found);
    previousIndex = found;
    targetIndex = found + 1;
  }

  // Prefer shorter targets when the whole query is a prefix or substring.
  if (lowerTarget === lowerQuery) score += 40;
  else if (lowerTarget.startsWith(lowerQuery)) score += 25;
  else if (lowerTarget.includes(lowerQuery)) score += 10;
  score -= Math.min(Math.floor(target.length / 12), 8);

  return { score, positions };
}

export interface FuzzyItem<T> {
  item: T;
  score: number;
  positions: number[];
}

export function fuzzyFilter<T>(
  items: readonly T[],
  query: string,
  toText: (item: T) => string,
  limit = 50,
): FuzzyItem<T>[] {
  const ranked: FuzzyItem<T>[] = [];
  for (const item of items) {
    const match = fuzzyMatch(query, toText(item));
    if (match) ranked.push({ item, score: match.score, positions: match.positions });
  }
  ranked.sort((a, b) => b.score - a.score || toText(a.item).length - toText(b.item).length);
  return ranked.slice(0, limit);
}
