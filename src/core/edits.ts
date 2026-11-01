import type { TextDocument } from './document';

/** A replacement of `[from, to)` with `text`. Positions are absolute offsets. */
export interface TextEdit {
  from: number;
  to: number;
  text: string;
}

/**
 * An edit that remembers what it destroyed. Undo needs the removed text; a
 * plain `TextEdit` alone can't be inverted.
 */
export interface AppliedEdit extends TextEdit {
  removed: string;
}

export function createEdits(doc: TextDocument, edits: readonly TextEdit[]): AppliedEdit[] {
  return edits.map((edit) => ({
    from: edit.from,
    to: edit.to,
    text: edit.text,
    removed: doc.text.slice(edit.from, edit.to),
  }));
}

/** Reverse a list of edits so it can be replayed to reach the previous state. */
export function invertEdits(edits: readonly AppliedEdit[]): AppliedEdit[] {
  return [...edits]
    .reverse()
    .map((edit) => ({
      from: edit.from,
      to: edit.from + edit.text.length,
      text: edit.removed,
      removed: edit.text,
    }));
}

/** Apply edits one after another, each addressing the result of the previous. */
export function applySequentialEdits(doc: TextDocument, edits: readonly TextEdit[]): TextDocument {
  let text = doc.text;
  for (const edit of edits) {
    text = text.slice(0, edit.from) + edit.text + text.slice(edit.to);
  }
  return doc.withText(text);
}

/**
 * Collapse overlapping edits produced by independent cursors.
 *
 * Two carets in the same word both hitting backspace must delete once, not
 * twice — otherwise the buffer corrupts in a way the user can't explain.
 */
export function normalizeEdits(edits: readonly TextEdit[]): TextEdit[] {
  const sorted = edits
    .filter((edit) => edit.from <= edit.to)
    .map((edit) => ({ ...edit }))
    .sort((a, b) => a.from - b.from || a.to - b.to);

  const merged: TextEdit[] = [];
  for (const edit of sorted) {
    const last = merged[merged.length - 1];
    if (last) {
      const samePointInsert = last.from === last.to && edit.from === edit.to && edit.from === last.from;
      const sameRange = last.from === edit.from && last.to === edit.to && last.from !== last.to;
      if (samePointInsert) {
        last.text += edit.text;
        continue;
      }
      if (sameRange || edit.from < last.to) {
        last.to = Math.max(last.to, edit.to);
        last.text += edit.text;
        continue;
      }
    }
    merged.push({ ...edit });
  }
  return merged;
}

/** Apply a set of simultaneous edits (multi-cursor), right to left. */
export function applyConcurrentEdits(doc: TextDocument, edits: readonly TextEdit[]): TextDocument {
  let text = doc.text;
  for (const edit of normalizeEdits(edits).reverse()) {
    text = text.slice(0, edit.from) + edit.text + text.slice(edit.to);
  }
  return doc.withText(text);
}

export interface ConcurrentResult {
  doc: TextDocument;
  /** One resulting caret per input edit, in the same order. */
  carets: number[];
}

/**
 * Apply simultaneous edits and report where each caret lands.
 * Overlapping edits collapse into one region and share its end offset.
 */
export function applyConcurrentEditsWithCarets(
  doc: TextDocument,
  edits: readonly TextEdit[],
): ConcurrentResult {
  interface Group {
    from: number;
    to: number;
    text: string;
    owners: number[];
  }

  const indexed = edits
    .map((edit, index) => ({ edit, index }))
    .filter(({ edit }) => edit.from <= edit.to)
    .sort((a, b) => a.edit.from - b.edit.from || a.edit.to - b.edit.to || a.index - b.index);

  const groups: Group[] = [];
  for (const { edit, index } of indexed) {
    const last = groups[groups.length - 1];
    if (last) {
      const samePointInsert =
        last.from === last.to && edit.from === edit.to && edit.from === last.from;
      const sameRange = last.from === edit.from && last.to === edit.to && last.from !== last.to;
      if (samePointInsert || sameRange || edit.from < last.to) {
        last.to = Math.max(last.to, edit.to);
        last.text += edit.text;
        last.owners.push(index);
        continue;
      }
    }
    groups.push({ from: edit.from, to: edit.to, text: edit.text, owners: [index] });
  }

  let text = doc.text;
  for (let i = groups.length - 1; i >= 0; i -= 1) {
    const group = groups[i];
    if (!group) continue;
    text = text.slice(0, group.from) + group.text + text.slice(group.to);
  }

  // Walk left to right, carrying the running offset change. A caret must land
  // after its own insertion *and* after every edit to its left.
  const carets = new Array<number>(edits.length).fill(0);
  let shift = 0;
  for (const group of groups) {
    const landing = group.from + shift + group.text.length;
    for (const owner of group.owners) carets[owner] = landing;
    shift += group.text.length - (group.to - group.from);
  }

  return { doc: doc.withText(text), carets };
}
