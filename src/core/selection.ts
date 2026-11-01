/** A caret with an anchor: `anchor === head` means collapsed. */
export interface Selection {
  anchor: number;
  head: number;
}

export function caret(offset: number): Selection {
  return { anchor: offset, head: offset };
}

export function isCollapsed(selection: Selection): boolean {
  return selection.anchor === selection.head;
}

export function selectionStart(selection: Selection): number {
  return Math.min(selection.anchor, selection.head);
}

export function selectionEnd(selection: Selection): number {
  return Math.max(selection.anchor, selection.head);
}

export function selectionLength(selection: Selection): number {
  return Math.abs(selection.head - selection.anchor);
}

export function clampSelection(selection: Selection, length: number): Selection {
  const bound = (value: number) => Math.max(0, Math.min(value, length));
  return { anchor: bound(selection.anchor), head: bound(selection.head) };
}

/** Order by position, keep the last selection as the "primary" caret. */
export function sortSelections(selections: readonly Selection[]): Selection[] {
  return [...selections].sort((a, b) => selectionStart(a) - selectionStart(b) || selectionEnd(a) - selectionEnd(b));
}

/** Drop exact duplicates and collapse identical carets. */
export function dedupeSelections(selections: readonly Selection[]): Selection[] {
  const seen = new Set<string>();
  const result: Selection[] = [];
  for (const selection of sortSelections(selections)) {
    const key = `${selection.anchor}:${selection.head}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(selection);
  }
  return result.length > 0 ? result : [caret(0)];
}

/**
 * Merge overlapping regions so multi-cursor edits never double-apply.
 * The last selection in the input stays primary.
 */
export function mergeSelections(selections: readonly Selection[]): Selection[] {
  const sorted = dedupeSelections(selections);
  const merged: Selection[] = [];
  for (const selection of sorted) {
    const previous = merged[merged.length - 1];
    if (
      previous &&
      (selectionStart(selection) < selectionEnd(previous) ||
        (selectionStart(selection) === selectionStart(previous) &&
          selectionEnd(selection) === selectionEnd(previous) &&
          !isCollapsed(selection)))
    ) {
      merged[merged.length - 1] = {
        anchor: selectionStart(previous),
        head: Math.max(selectionEnd(previous), selectionEnd(selection)),
      };
      continue;
    }
    merged.push(selection);
  }
  return merged.length > 0 ? merged : [caret(0)];
}

export function primarySelection(selections: readonly Selection[]): Selection {
  return selections[selections.length - 1] ?? caret(0);
}

export function selectionsEqual(a: readonly Selection[], b: readonly Selection[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((selection, index) => {
    const other = b[index];
    return other !== undefined && selection.anchor === other.anchor && selection.head === other.head;
  });
}
