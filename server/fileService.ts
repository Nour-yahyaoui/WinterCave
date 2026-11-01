/**
 * The only module that touches the filesystem.
 *
 * Writes are atomic: the new text lands in a temp file next to the target, is
 * flushed, and is then renamed over the target. A crash mid-write therefore
 * leaves either the old file or the new one, never a half-written buffer. This
 * is the part most "tiny servers" get wrong, so it has its own tests.
 */

import { randomBytes } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { assertRelativePath, baseName, isInside, PathError, resolveInside } from './paths.ts';

export const DEFAULT_MAX_BYTES = 10_000_000;

export type LineEndingName = 'lf' | 'crlf';

export interface FileServiceOptions {
  /** Directory that every request is confined to. */
  root: string;
  /** Refuse to read or write files larger than this. */
  maxBytes?: number;
  /** Serve reads only; writes answer 403. */
  readOnly?: boolean;
}

export interface FileRecord {
  path: string;
  name: string;
  text: string;
  size: number;
  mtime: number;
  lineEnding: LineEndingName;
  readOnly: boolean;
}

export interface WriteResult {
  path: string;
  name: string;
  size: number;
  mtime: number;
}

export interface TreeEntry {
  name: string;
  path: string;
  type: 'file' | 'dir';
  size?: number;
}

export interface TreeResult {
  path: string;
  entries: TreeEntry[];
}

export class FileServiceError extends Error {
  override readonly name = 'FileServiceError';
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const IGNORED_ENTRIES = new Set(['.git', 'node_modules', 'target', '.DS_Store']);
const BINARY_SNIFF_BYTES = 8000;

function statusError(status: number, code: string, message: string): FileServiceError {
  return new FileServiceError(status, code, message);
}

function describe(error: unknown): FileServiceError {
  if (error instanceof FileServiceError) return error;
  if (error instanceof PathError) return statusError(400, 'bad_path', error.message);
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  switch (code) {
    case 'ENOENT':
      return statusError(404, 'not_found', 'No such file.');
    case 'EACCES':
    case 'EPERM':
      return statusError(403, 'forbidden', 'Permission denied.');
    case 'EISDIR':
      return statusError(409, 'is_a_directory', 'That path is a directory.');
    case 'ENOSPC':
      return statusError(507, 'no_space', 'No space left on device.');
    default:
      return statusError(500, 'io_error', error instanceof Error ? error.message : 'I/O failed.');
  }
}

export function detectLineEnding(text: string): LineEndingName {
  let crlf = 0;
  let lf = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) {
      if (index > 0 && text.charCodeAt(index - 1) === 13) crlf += 1;
      else lf += 1;
    }
  }
  return crlf > lf ? 'crlf' : 'lf';
}

export function countBytes(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

export class FileService {
  readonly root: string;
  readonly maxBytes: number;
  readonly readOnly: boolean;

  constructor(options: FileServiceOptions) {
    this.root = path.resolve(options.root);
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.readOnly = options.readOnly === true;
  }

  /** Resolve a request path to an absolute path inside the root. */
  absolute(relative: string): { relative: string; absolute: string } {
    const normalized = assertRelativePath(relative);
    return { relative: normalized, absolute: resolveInside(this.root, normalized) };
  }

  /**
   * Guard against symlinks that point outside the workspace: the deepest
   * existing directory of the target must still be inside the real root.
   */
  private async assertContained(absolute: string): Promise<void> {
    const realRoot = await fsp.realpath(this.root);
    let probe = path.dirname(absolute);
    for (;;) {
      try {
        const realProbe = await fsp.realpath(probe);
        if (!isInside(realRoot, realProbe)) {
          throw statusError(400, 'bad_path', 'Path escapes the workspace through a link.');
        }
        return;
      } catch (error) {
        if (error instanceof FileServiceError) throw error;
        const parent = path.dirname(probe);
        if (parent === probe) return;
        probe = parent;
      }
    }
  }

  async read(relative: string): Promise<FileRecord> {
    try {
      const { relative: normalized, absolute } = this.absolute(relative);
      await this.assertContained(absolute);
      const stats = await fsp.stat(absolute);
      if (stats.isDirectory()) throw statusError(409, 'is_a_directory', 'That path is a directory.');
      if (!stats.isFile()) throw statusError(400, 'not_a_file', 'That path is not a regular file.');
      if (stats.size > this.maxBytes) {
        throw statusError(413, 'too_large', `File is larger than ${this.maxBytes} bytes.`);
      }

      const buffer = await fsp.readFile(absolute);
      const head = buffer.subarray(0, BINARY_SNIFF_BYTES);
      if (head.includes(0)) throw statusError(415, 'binary', 'That file looks binary.');

      let text: string;
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
      } catch {
        throw statusError(415, 'binary', 'That file is not valid UTF-8.');
      }

      return {
        path: normalized,
        name: baseName(normalized),
        text,
        size: stats.size,
        mtime: stats.mtimeMs,
        lineEnding: detectLineEnding(text),
        readOnly: this.readOnly,
      };
    } catch (error) {
      throw describe(error);
    }
  }

  async write(
    relative: string,
    text: unknown,
    options: { create?: boolean } = {},
  ): Promise<WriteResult> {
    try {
      if (this.readOnly) throw statusError(403, 'read_only', 'This server is read-only.');
      if (typeof text !== 'string') throw statusError(400, 'bad_body', 'Expected a "text" string.');

      const { relative: normalized, absolute } = this.absolute(relative);
      const bytes = countBytes(text);
      if (bytes > this.maxBytes) {
        throw statusError(413, 'too_large', `Refusing to write more than ${this.maxBytes} bytes.`);
      }

      await this.assertContained(absolute);
      const existing = await fsp.stat(absolute).catch(() => null);
      if (existing?.isDirectory()) throw statusError(409, 'is_a_directory', 'That path is a directory.');
      if (!existing && options.create !== true) {
        throw statusError(404, 'not_found', 'No such file. Create it first.');
      }
      if (!existing) {
        await fsp.mkdir(path.dirname(absolute), { recursive: true });
      }

      await writeAtomically(absolute, text, existing?.mode);

      const stats = await fsp.stat(absolute);
      return {
        path: normalized,
        name: baseName(normalized),
        size: stats.size,
        mtime: stats.mtimeMs,
      };
    } catch (error) {
      throw describe(error);
    }
  }

  async remove(relative: string): Promise<{ path: string }> {
    try {
      if (this.readOnly) throw statusError(403, 'read_only', 'This server is read-only.');
      const { relative: normalized, absolute } = this.absolute(relative);
      await this.assertContained(absolute);
      await fsp.unlink(absolute);
      return { path: normalized };
    } catch (error) {
      throw describe(error);
    }
  }

  async tree(relative = '.'): Promise<TreeResult> {
    try {
      const normalized = relative === '.' || relative === '' ? '' : assertRelativePath(relative);
      const directory = normalized === '' ? this.root : resolveInside(this.root, normalized);
      const dirents = await fsp.readdir(directory, { withFileTypes: true });

      const entries: TreeEntry[] = [];
      for (const dirent of dirents) {
        if (IGNORED_ENTRIES.has(dirent.name)) continue;
        const entryPath = normalized === '' ? dirent.name : `${normalized}/${dirent.name}`;
        if (dirent.isDirectory()) {
          entries.push({ name: dirent.name, path: entryPath, type: 'dir' });
        } else if (dirent.isFile()) {
          const stats = await fsp.stat(path.join(directory, dirent.name)).catch(() => null);
          entries.push({
            name: dirent.name,
            path: entryPath,
            type: 'file',
            size: stats?.size ?? 0,
          });
        }
      }

      entries.sort((a, b) => {
        if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      return { path: normalized, entries };
    } catch (error) {
      throw describe(error);
    }
  }

  async health(): Promise<{ root: string; maxBytes: number; readOnly: boolean }> {
    return { root: this.root, maxBytes: this.maxBytes, readOnly: this.readOnly };
  }
}

async function writeAtomically(target: string, text: string, mode?: number): Promise<void> {
  const directory = path.dirname(target);
  const temp = path.join(
    directory,
    `.${path.basename(target)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`,
  );

  const handle = await fsp.open(temp, 'w', 0o600);
  try {
    await handle.writeFile(text, 'utf8');
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => undefined);
    await fsp.unlink(temp).catch(() => undefined);
    throw error;
  }
  await handle.close();

  try {
    if (mode !== undefined) await fsp.chmod(temp, mode);
    await fsp.rename(temp, target);
  } catch (error) {
    await fsp.unlink(temp).catch(() => undefined);
    throw error;
  }

  // Make the rename itself durable. Not every platform allows this; ignore.
  try {
    const directoryHandle = await fsp.open(directory, 'r');
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } catch {
    /* best effort */
  }
}
