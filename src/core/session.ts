import { LIMITS, byteLength } from './limits';
import type { Selection } from './selection';
import type { LineEnding } from './text';

export const SESSION_VERSION = 1;
export const SESSION_KEY = 'wintercave.session.v1';
export const JOURNAL_KEY = 'wintercave.journal.v1';

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface SerializedDocument {
  id: string;
  name: string;
  path?: string;
  language: string;
  text: string;
  savedText: string;
  selections: Selection[];
  scrollTop: number;
  lineEnding: LineEnding;
  readOnly: boolean;
  modifiedAt: number;
}

export interface SerializedSession {
  version: number;
  activeId: string | null;
  documents: SerializedDocument[];
  updatedAt: number;
}

export interface JournalEntry {
  id: string;
  name: string;
  language: string;
  text: string;
  selections: Selection[];
  updatedAt: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseSelections(value: unknown): Selection[] {
  if (!Array.isArray(value)) return [{ anchor: 0, head: 0 }];
  const selections: Selection[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const anchor = entry['anchor'];
    const head = entry['head'];
    if (typeof anchor === 'number' && typeof head === 'number' && Number.isFinite(anchor) && Number.isFinite(head)) {
      selections.push({ anchor, head });
    }
  }
  return selections.length > 0 ? selections : [{ anchor: 0, head: 0 }];
}

function parseDocument(value: unknown): SerializedDocument | null {
  if (!isRecord(value)) return null;
  const { id, name, text, savedText } = value;
  if (typeof id !== 'string' || typeof name !== 'string' || typeof text !== 'string') return null;
  const lineEnding = value['lineEnding'] === '\r\n' ? '\r\n' : '\n';
  return {
    id,
    name,
    path: typeof value['path'] === 'string' ? value['path'] : undefined,
    language: typeof value['language'] === 'string' ? value['language'] : 'plaintext',
    text,
    savedText: typeof savedText === 'string' ? savedText : text,
    selections: parseSelections(value['selections']),
    scrollTop: typeof value['scrollTop'] === 'number' && Number.isFinite(value['scrollTop']) ? value['scrollTop'] : 0,
    lineEnding,
    readOnly: value['readOnly'] === true,
    modifiedAt: typeof value['modifiedAt'] === 'number' ? value['modifiedAt'] : 0,
  };
}

export function parseSession(raw: string | null): SerializedSession | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  if (parsed['version'] !== SESSION_VERSION) return null;
  const documents = Array.isArray(parsed['documents'])
    ? parsed['documents'].map(parseDocument).filter((doc): doc is SerializedDocument => doc !== null)
    : [];
  return {
    version: SESSION_VERSION,
    activeId: typeof parsed['activeId'] === 'string' ? parsed['activeId'] : null,
    documents,
    updatedAt: typeof parsed['updatedAt'] === 'number' ? parsed['updatedAt'] : Date.now(),
  };
}

export function serializeSession(
  documents: readonly SerializedDocument[],
  activeId: string | null,
  now: number = Date.now(),
): string {
  const session: SerializedSession = {
    version: SESSION_VERSION,
    activeId,
    documents: [...documents],
    updatedAt: now,
  };
  return JSON.stringify(session);
}

/** Trim oversized sessions instead of losing the whole thing to a quota error. */
export function fitToBudget(documents: readonly SerializedDocument[], maxBytes: number): SerializedDocument[] {
  const kept: SerializedDocument[] = [];
  let total = 0;
  for (const document of [...documents].sort((a, b) => b.modifiedAt - a.modifiedAt)) {
    const size = byteLength(document.text);
    if (total + size > maxBytes) continue;
    kept.push(document);
    total += size;
  }
  return kept.reverse();
}

export function saveSession(
  storage: StorageLike,
  documents: readonly SerializedDocument[],
  activeId: string | null,
): boolean {
  const attempts: SerializedDocument[][] = [
    [...documents],
    fitToBudget(documents, LIMITS.journalBytes),
    fitToBudget(documents, Math.floor(LIMITS.journalBytes / 2)),
    [],
  ];
  for (const attempt of attempts) {
    try {
      storage.setItem(SESSION_KEY, serializeSession(attempt, activeId));
      return true;
    } catch {
      // Quota exceeded — try a smaller slice.
    }
  }
  return false;
}

export function loadSession(storage: StorageLike): SerializedSession | null {
  try {
    return parseSession(storage.getItem(SESSION_KEY));
  } catch {
    return null;
  }
}

export function clearSession(storage: StorageLike): void {
  try {
    storage.removeItem(SESSION_KEY);
  } catch {
    /* storage may be unavailable (private mode) */
  }
}

export function parseJournal(raw: string | null): JournalEntry[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!isRecord(parsed) || !Array.isArray(parsed['entries'])) return [];
  const entries: JournalEntry[] = [];
  for (const value of parsed['entries']) {
    if (!isRecord(value)) continue;
    const text = value['text'];
    if (typeof value['id'] !== 'string' || typeof value['name'] !== 'string' || typeof text !== 'string') continue;
    entries.push({
      id: value['id'],
      name: value['name'],
      language: typeof value['language'] === 'string' ? value['language'] : 'plaintext',
      text,
      selections: parseSelections(value['selections']),
      updatedAt: typeof value['updatedAt'] === 'number' ? value['updatedAt'] : 0,
    });
  }
  return entries;
}

/** Recovery journal: only unsaved buffers, newest first, capped by bytes. */
export function writeJournal(storage: StorageLike, entries: readonly JournalEntry[]): boolean {
  const kept: JournalEntry[] = [];
  let total = 0;
  for (const entry of [...entries].sort((a, b) => b.updatedAt - a.updatedAt)) {
    if (kept.length >= LIMITS.journalEntries) break;
    const size = byteLength(entry.text);
    if (size > LIMITS.journalBytes) continue;
    if (total + size > LIMITS.journalBytes) continue;
    kept.push(entry);
    total += size;
  }
  try {
    storage.setItem(JOURNAL_KEY, JSON.stringify({ version: 1, entries: kept }));
    return true;
  } catch {
    try {
      storage.removeItem(JOURNAL_KEY);
    } catch {
      /* ignore */
    }
    return false;
  }
}

export function readJournal(storage: StorageLike): JournalEntry[] {
  try {
    return parseJournal(storage.getItem(JOURNAL_KEY));
  } catch {
    return [];
  }
}

export function clearJournal(storage: StorageLike): void {
  try {
    storage.removeItem(JOURNAL_KEY);
  } catch {
    /* ignore */
  }
}
