/**
 * Size policy. These numbers are the difference between "an editor" and
 * "a tab that hangs", so they live in the core where they can be tested.
 */
export const LIMITS = {
  /** Above this, opening warns: highlighting may be reduced. */
  warnBytes: 5_000_000,
  /** Above this, refuse to open unless the user insists (read-only). */
  refuseBytes: 50_000_000,
  /** Above this, syntax highlighting is switched off to keep keystrokes fast. */
  highlightBytes: 2_000_000,
  highlightLines: 20_000,
  /** Total budget for the crash-recovery journal (localStorage). */
  journalBytes: 2_000_000,
  journalEntries: 12,
  /** Saved versions kept per file for the local timeline. */
  historySnapshots: 20,
  historySnapshotBytes: 400_000,
} as const;

export type SizeClass = 'ok' | 'warn' | 'refuse';

export function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

export function classifySize(bytes: number): SizeClass {
  if (bytes >= LIMITS.refuseBytes) return 'refuse';
  if (bytes >= LIMITS.warnBytes) return 'warn';
  return 'ok';
}

export function shouldHighlight(bytes: number, lineCount: number): boolean {
  return bytes <= LIMITS.highlightBytes && lineCount <= LIMITS.highlightLines;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
