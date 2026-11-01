/**
 * Static hosting for the built web shell. Anything that is not `/api/*` lands
 * here; unknown extension-less paths fall back to `index.html` so deep links
 * keep working.
 */

import { createReadStream } from 'node:fs';
import fsp from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';

import { isInside, resolveInside } from './paths.ts';

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
};

export interface StaticOptions {
  /** Directory holding the built app. */
  directory: string;
  /** Serve this file for unknown extension-less paths. */
  spaFallback?: boolean;
}

export function contentTypeFor(fileName: string): string {
  return CONTENT_TYPES[path.extname(fileName).toLowerCase()] ?? 'application/octet-stream';
}

function etagFor(size: number, mtimeMs: number): string {
  return `"${size.toString(16)}-${Math.floor(mtimeMs).toString(16)}"`;
}

async function sendFile(
  req: IncomingMessage,
  res: ServerResponse,
  filePath: string,
  status = 200,
): Promise<void> {
  const stats = await fsp.stat(filePath);
  if (!stats.isFile()) throw Object.assign(new Error('not a file'), { code: 'ENOENT' });

  const etag = etagFor(stats.size, stats.mtimeMs);
  const headers: Record<string, string | number> = {
    'Content-Type': contentTypeFor(filePath),
    'Content-Length': stats.size,
    ETag: etag,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': filePath.endsWith('index.html')
      ? 'no-cache'
      : 'public, max-age=31536000, immutable',
  };

  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { ETag: etag, 'Cache-Control': headers['Cache-Control'] as string });
    res.end();
    return;
  }

  res.writeHead(status, headers);
  if (req.method === 'HEAD') {
    res.end();
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on('error', reject);
    stream.on('end', resolve);
    stream.pipe(res);
  });
}

/**
 * Try to serve `urlPath` from the static directory. Returns false when nothing
 * matched, so the caller can answer 404.
 */
export async function serveStatic(
  req: IncomingMessage,
  res: ServerResponse,
  urlPath: string,
  options: StaticOptions,
): Promise<boolean> {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;

  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Malformed URL');
    return true;
  }
  if (decoded.includes('\0')) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Malformed URL');
    return true;
  }

  const relative = decoded.replace(/^\/+/, '');
  const directory = path.resolve(options.directory);

  const attempt = async (candidate: string): Promise<boolean> => {
    try {
      const absolute = candidate === '' ? directory : resolveInside(directory, candidate);
      if (!isInside(directory, absolute)) return false;
      const stats = await fsp.stat(absolute);
      if (stats.isDirectory()) return attempt(path.join(candidate, 'index.html'));
      await sendFile(req, res, absolute);
      return true;
    } catch {
      return false;
    }
  };

  if (relative === '') {
    if (await attempt('index.html')) return true;
  } else if (await attempt(relative)) {
    return true;
  }

  const looksLikeAsset = path.extname(relative) !== '';
  if (options.spaFallback !== false && !looksLikeAsset) {
    return attempt('index.html');
  }
  return false;
}
