/**
 * Path handling for the file API.
 *
 * The rule is boring on purpose: every request resolves to something inside the
 * workspace root, or it is rejected. No "..", no absolute paths, no NUL bytes.
 * A rejected path never reaches the filesystem.
 */

import path from 'node:path';

export class PathError extends Error {
  override readonly name = 'PathError';
}

const MAX_RELATIVE_LENGTH = 4096;

function normalizeSeparators(input: string): string {
  return input.replace(/\\/g, '/');
}

/** Validate a client-supplied relative path without touching the disk. */
export function assertRelativePath(requested: unknown): string {
  if (typeof requested !== 'string' || requested.length === 0) {
    throw new PathError('A file path is required.');
  }
  if (requested.length > MAX_RELATIVE_LENGTH) {
    throw new PathError('Path is too long.');
  }
  if (requested.includes('\0')) {
    throw new PathError('Path contains a NUL byte.');
  }

  const normalized = normalizeSeparators(requested);
  if (normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)) {
    throw new PathError('Absolute paths are not allowed.');
  }

  for (const segment of normalized.split('/')) {
    if (segment === '..') {
      throw new PathError('Path escapes the workspace.');
    }
    if (segment === '' || segment === '.') {
      throw new PathError('Path contains an empty segment.');
    }
  }
  return normalized;
}

/** Join a validated relative path to the root, defending against prefix tricks. */
export function resolveInside(root: string, relative: string): string {
  const base = path.resolve(root);
  const target = path.resolve(base, relative);
  if (target !== base && !target.startsWith(base + path.sep)) {
    throw new PathError('Path escapes the workspace.');
  }
  return target;
}

/** True when `candidate` is inside (or equal to) `root`. */
export function isInside(root: string, candidate: string): boolean {
  const base = path.resolve(root);
  return candidate === base || candidate.startsWith(base + path.sep);
}

/** `foo/bar.txt` → `bar.txt`, `foo/bar/` → `bar`. */
export function baseName(relative: string): string {
  return path.basename(normalizeSeparators(relative).replace(/\/+$/, ''));
}
