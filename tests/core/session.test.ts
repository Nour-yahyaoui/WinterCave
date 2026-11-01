import { describe, expect, it } from 'vitest';
import { LIMITS } from '../../src/core/limits';
import {
  JOURNAL_KEY,
  SESSION_KEY,
  clearJournal,
  clearSession,
  fitToBudget,
  loadSession,
  parseJournal,
  parseSession,
  readJournal,
  saveSession,
  serializeSession,
  writeJournal,
  type JournalEntry,
  type SerializedDocument,
  type StorageLike,
} from '../../src/core/session';

class MemoryStorage implements StorageLike {
  readonly map = new Map<string, string>();
  failWrites = false;

  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    if (this.failWrites) throw new Error('QuotaExceededError');
    this.map.set(key, value);
  }

  removeItem(key: string): void {
    this.map.delete(key);
  }
}

const document = (overrides: Partial<SerializedDocument> = {}): SerializedDocument => ({
  id: 'doc-1',
  name: 'notes.md',
  language: 'markdown',
  text: '# hello',
  savedText: '# hello',
  selections: [{ anchor: 0, head: 0 }],
  scrollTop: 12,
  lineEnding: '\n',
  readOnly: false,
  modifiedAt: 1,
  ...overrides,
});

describe('session round-trip', () => {
  it('restores documents, cursors and the active tab', () => {
    const storage = new MemoryStorage();
    expect(saveSession(storage, [document(), document({ id: 'doc-2', name: 'b.ts', text: 'x' })], 'doc-2')).toBe(true);
    const session = loadSession(storage);
    expect(session?.documents).toHaveLength(2);
    expect(session?.activeId).toBe('doc-2');
    expect(session?.documents[0]?.scrollTop).toBe(12);
    expect(session?.documents[0]?.selections).toEqual([{ anchor: 0, head: 0 }]);
  });

  it('returns null for missing, corrupt or future sessions', () => {
    const storage = new MemoryStorage();
    expect(loadSession(storage)).toBeNull();
    storage.setItem(SESSION_KEY, '{not json');
    expect(loadSession(storage)).toBeNull();
    storage.setItem(SESSION_KEY, JSON.stringify({ version: 99, documents: [] }));
    expect(loadSession(storage)).toBeNull();
  });

  it('drops malformed documents instead of failing the whole restore', () => {
    const raw = JSON.stringify({
      version: 1,
      activeId: 'a',
      documents: [document(), { id: 5 }, null, { id: 'ok', name: 'c', text: 'x' }],
      updatedAt: 0,
    });
    const session = parseSession(raw);
    expect(session?.documents.map((entry) => entry.id)).toEqual(['doc-1', 'ok']);
  });

  it('defaults missing fields to safe values', () => {
    const session = parseSession(JSON.stringify({ version: 1, documents: [{ id: 'a', name: 'b', text: 'x' }] }));
    const restored = session!.documents[0]!;
    expect(restored.language).toBe('plaintext');
    expect(restored.lineEnding).toBe('\n');
    expect(restored.readOnly).toBe(false);
    expect(restored.selections).toEqual([{ anchor: 0, head: 0 }]);
    expect(restored.savedText).toBe('x');
  });

  it('survives a storage that refuses to write', () => {
    const storage = new MemoryStorage();
    storage.failWrites = true;
    expect(saveSession(storage, [document()], null)).toBe(false);
  });

  it('clears a session', () => {
    const storage = new MemoryStorage();
    saveSession(storage, [document()], 'doc-1');
    clearSession(storage);
    expect(storage.getItem(SESSION_KEY)).toBeNull();
  });

  it('serialises with a version stamp', () => {
    expect(JSON.parse(serializeSession([document()], null, 42)).version).toBe(1);
  });
});

describe('budget fitting', () => {
  it('keeps the most recently modified documents that fit', () => {
    const big = document({ id: 'recent', text: 'x'.repeat(80), modifiedAt: 10 });
    const old = document({ id: 'old', text: 'y'.repeat(80), modifiedAt: 1 });
    const kept = fitToBudget([big, old], 100);
    expect(kept.map((entry) => entry.id)).toEqual(['recent']);
  });

  it('returns everything when it all fits', () => {
    expect(fitToBudget([document()], LIMITS.journalBytes)).toHaveLength(1);
  });
});

describe('recovery journal', () => {
  const entry = (overrides: Partial<JournalEntry> = {}): JournalEntry => ({
    id: 'doc-1',
    name: 'notes.md',
    language: 'markdown',
    text: '# unsaved',
    selections: [{ anchor: 3, head: 3 }],
    updatedAt: 100,
    ...overrides,
  });

  it('round-trips unsaved buffers', () => {
    const storage = new MemoryStorage();
    expect(writeJournal(storage, [entry()])).toBe(true);
    const restored = readJournal(storage);
    expect(restored).toHaveLength(1);
    expect(restored[0]?.text).toBe('# unsaved');
  });

  it('keeps only the newest entries', () => {
    const storage = new MemoryStorage();
    const entries = Array.from({ length: LIMITS.journalEntries + 4 }, (_, index) =>
      entry({ id: `doc-${index}`, updatedAt: index }),
    );
    writeJournal(storage, entries);
    const restored = readJournal(storage);
    expect(restored).toHaveLength(LIMITS.journalEntries);
    expect(restored[0]?.id).toBe(`doc-${LIMITS.journalEntries + 3}`);
  });

  it('skips buffers larger than the whole budget', () => {
    const storage = new MemoryStorage();
    writeJournal(storage, [entry({ text: 'x'.repeat(LIMITS.journalBytes + 1) })]);
    expect(readJournal(storage)).toHaveLength(0);
  });

  it('clears the journal after a successful restore', () => {
    const storage = new MemoryStorage();
    writeJournal(storage, [entry()]);
    clearJournal(storage);
    expect(storage.getItem(JOURNAL_KEY)).toBeNull();
  });

  it('handles corrupt journal data', () => {
    expect(parseJournal('nope')).toEqual([]);
    expect(parseJournal(JSON.stringify({ entries: [{ id: 1 }] }))).toEqual([]);
  });

  it('reports failure when storage is full', () => {
    const storage = new MemoryStorage();
    storage.failWrites = true;
    expect(writeJournal(storage, [entry()])).toBe(false);
  });
});
