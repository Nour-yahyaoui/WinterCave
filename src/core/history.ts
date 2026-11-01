import type { TextDocument } from './document';
import { applySequentialEdits, invertEdits, type AppliedEdit } from './edits';
import { clampSelection, isCollapsed, type Selection } from './selection';

export type EditKind = 'insert' | 'delete' | 'replace' | 'paste' | 'indent' | 'structure';

export interface HistoryRecord {
  edits: AppliedEdit[];
  selBefore: Selection[];
  selAfter: Selection[];
  kind: EditKind;
  at: number;
}

export interface HistoryResult {
  doc: TextDocument;
  selections: Selection[];
}

export interface HistoryOptions {
  /** Undo depth. Tier 0 requires >= 1000. */
  limit?: number;
  /** Typing bursts closer together than this collapse into one undo step. */
  groupWindowMs?: number;
  now?: () => number;
}

const isSingleCaret = (selections: readonly Selection[]): boolean =>
  selections.length === 1 && selections[0] !== undefined && isCollapsed(selections[0]);

/**
 * Undo/redo over edit records (not whole-document snapshots), so a 10MB file
 * doesn't allocate 10GB of history. Sequential edits invert in reverse order.
 */
export class History {
  private undoStack: HistoryRecord[] = [];
  private redoStack: HistoryRecord[] = [];
  private readonly limit: number;
  private readonly groupWindowMs: number;
  private readonly now: () => number;

  constructor(options: HistoryOptions = {}) {
    this.limit = Math.max(1, options.limit ?? 1000);
    this.groupWindowMs = Math.max(0, options.groupWindowMs ?? 500);
    this.now = options.now ?? (() => Date.now());
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  get undoDepth(): number {
    return this.undoStack.length;
  }

  get redoDepth(): number {
    return this.redoStack.length;
  }

  get groupWindow(): number {
    return this.groupWindowMs;
  }

  push(record: Omit<HistoryRecord, 'at'> & { at?: number }): void {
    if (record.edits.length === 0) return;
    const at = record.at ?? this.now();
    const top = this.undoStack[this.undoStack.length - 1];
    this.redoStack = [];

    if (top && this.shouldGroup(top, record, at)) {
      top.edits = [...top.edits, ...record.edits];
      top.selAfter = record.selAfter;
      top.at = at;
      return;
    }

    this.undoStack.push({ ...record, at });
    if (this.undoStack.length > this.limit) this.undoStack.shift();
  }

  private shouldGroup(
    top: HistoryRecord,
    record: Omit<HistoryRecord, 'at'> & { at?: number },
    at: number,
  ): boolean {
    if (top.kind !== record.kind) return false;
    if (top.kind !== 'insert' && top.kind !== 'delete') return false;
    if (at - top.at > this.groupWindowMs) return false;
    if (!isSingleCaret(top.selAfter) || !isSingleCaret(record.selBefore)) return false;
    return top.selAfter[0]?.head === record.selBefore[0]?.head;
  }

  undo(doc: TextDocument): HistoryResult | null {
    const record = this.undoStack.pop();
    if (!record) return null;
    const nextDoc = applySequentialEdits(doc, invertEdits(record.edits));
    this.redoStack.push(record);
    return { doc: nextDoc, selections: record.selBefore.map((s) => clampSelection(s, nextDoc.length)) };
  }

  redo(doc: TextDocument): HistoryResult | null {
    const record = this.redoStack.pop();
    if (!record) return null;
    const nextDoc = applySequentialEdits(doc, record.edits);
    this.undoStack.push(record);
    return { doc: nextDoc, selections: record.selAfter.map((s) => clampSelection(s, nextDoc.length)) };
  }

  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
  }
}
