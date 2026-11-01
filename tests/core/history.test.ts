import { describe, expect, it } from 'vitest';
import { TextDocument } from '../../src/core/document';
import { createEdits } from '../../src/core/edits';
import { History } from '../../src/core/history';
import type { Selection } from '../../src/core/selection';

let clock = 0;
const makeHistory = (options?: { limit?: number; groupWindowMs?: number }) =>
  new History({ ...options, now: () => clock });

function type(
  history: History,
  doc: TextDocument,
  offset: number,
  text: string,
  before: number,
  after: number,
): { doc: TextDocument; selections: Selection[] } {
  const edits = createEdits(doc, [{ from: offset, to: offset, text }]);
  const next = doc.insert(offset, text);
  const selections = [{ anchor: after, head: after }];
  history.push({
    edits,
    kind: 'insert',
    selBefore: [{ anchor: before, head: before }],
    selAfter: selections,
  });
  return { doc: next, selections };
}

describe('History', () => {
  it('undoes and redoes a single edit', () => {
    const history = makeHistory();
    const start = new TextDocument('abc');
    clock = 0;
    const typed = type(history, start, 1, 'X', 1, 2);

    const undone = history.undo(typed.doc);
    expect(undone?.doc.text).toBe('abc');
    expect(undone?.selections).toEqual([{ anchor: 1, head: 1 }]);

    const redone = history.redo(undone!.doc);
    expect(redone?.doc.text).toBe('aXbc');
    expect(redone?.selections).toEqual([{ anchor: 2, head: 2 }]);
  });

  it('groups a typing burst inside the window', () => {
    const history = makeHistory({ groupWindowMs: 500 });
    let doc = new TextDocument('');
    let caret = 0;
    for (const char of 'hello') {
      clock += 100;
      const result = type(history, doc, caret, char, caret, caret + 1);
      doc = result.doc;
      caret += 1;
    }
    expect(doc.text).toBe('hello');
    expect(history.undoDepth).toBe(1);
    expect(history.undo(doc)?.doc.text).toBe('');
  });

  it('starts a new group after a pause', () => {
    const history = makeHistory({ groupWindowMs: 500 });
    let doc = new TextDocument('');
    let caret = 0;
    clock = 0;
    for (const char of 'ab') {
      const result = type(history, doc, caret, char, caret, caret + 1);
      doc = result.doc;
      caret += 1;
    }
    clock += 2000;
    const result = type(history, doc, caret, 'c', caret, caret + 1);
    doc = result.doc;
    expect(history.undoDepth).toBe(2);
    expect(history.undo(doc)?.doc.text).toBe('ab');
  });

  it('does not group typing that jumps to another place', () => {
    const history = makeHistory({ groupWindowMs: 5000 });
    let doc = new TextDocument('abcdef');
    clock = 10;
    doc = type(history, doc, 0, 'X', 0, 1).doc;
    clock = 20;
    doc = type(history, doc, 6, 'Y', 6, 7).doc;
    expect(doc.text).toBe('XabcdeYf');
    expect(history.undoDepth).toBe(2);
    expect(history.undo(doc)?.doc.text).toBe('Xabcdef');
  });

  it('clears redo when new typing arrives', () => {
    const history = makeHistory();
    let doc = new TextDocument('abc');
    clock = 0;
    doc = type(history, doc, 0, 'X', 0, 1).doc;
    const undone = history.undo(doc)!;
    expect(history.canRedo).toBe(true);
    clock = 5000;
    type(history, undone.doc, 3, 'Z', 3, 4);
    expect(history.canRedo).toBe(false);
  });

  it('enforces the undo limit', () => {
    const history = makeHistory({ limit: 3, groupWindowMs: 0 });
    let doc = new TextDocument('');
    for (let i = 0; i < 5; i += 1) {
      clock = i * 1000;
      doc = type(history, doc, doc.length, String(i), doc.length, doc.length + 1).doc;
    }
    expect(history.undoDepth).toBe(3);
    let current: TextDocument = doc;
    for (let i = 0; i < 3; i += 1) {
      const result = history.undo(current);
      expect(result).not.toBeNull();
      current = result!.doc;
    }
    expect(history.undo(current)).toBeNull();
  });

  it('returns null when there is nothing to undo', () => {
    const history = makeHistory();
    expect(history.undo(new TextDocument(''))).toBeNull();
    expect(history.redo(new TextDocument(''))).toBeNull();
  });

  it('clamps restored selections to the restored document', () => {
    const history = makeHistory();
    const start = new TextDocument('abc');
    const edits = createEdits(start, [{ from: 1, to: 3, text: '' }]);
    history.push({
      edits,
      kind: 'delete',
      selBefore: [{ anchor: 3, head: 3 }],
      selAfter: [{ anchor: 1, head: 1 }],
    });
    const undone = history.undo(start.remove(1, 3));
    expect(undone?.doc.text).toBe('abc');
    expect(undone?.selections).toEqual([{ anchor: 3, head: 3 }]);
  });
});
