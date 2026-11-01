/**
 * Request routing. No side effects beyond the response: everything that touches
 * the disk lives in `FileService`, everything that serves the app lives in
 * `static.ts`. That split is what makes the API testable without a browser.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

import { FileService, FileServiceError, type TreeResult } from './fileService.ts';
import { serveStatic, type StaticOptions } from './static.ts';

export const SERVER_NAME = 'wintercave-server';
export const BODY_LIMIT = 12_000_000;

export interface AppOptions {
  files: FileService;
  /** Static hosting; omit for an API-only server. */
  assets?: StaticOptions;
  version?: string;
  /** Silences the request log in tests. */
  quiet?: boolean;
}

type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

function sendError(res: ServerResponse, status: number, code: string, message: string): void {
  sendJson(res, status, { error: { code, message } });
}

function cors(req: IncomingMessage, res: ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') res.setHeader('Access-Control-Max-Age', '600');
}

async function readBody(req: IncomingMessage, limit = BODY_LIMIT): Promise<string> {
  const declared = Number(req.headers['content-length'] ?? '0');
  if (Number.isFinite(declared) && declared > limit) {
    throw new FileServiceError(413, 'too_large', 'Request body is too large.');
  }

  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    total += buffer.length;
    if (total > limit) {
      throw new FileServiceError(413, 'too_large', 'Request body is too large.');
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function readJson(req: IncomingMessage, limit = BODY_LIMIT): Promise<Record<string, unknown>> {
  const raw = await readBody(req, limit);
  if (raw.trim() === '') return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new FileServiceError(400, 'bad_body', 'Expected a JSON object.');
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof FileServiceError) throw error;
    throw new FileServiceError(400, 'bad_json', 'Request body is not valid JSON.');
  }
}

function queryPath(url: URL): string {
  const value = url.searchParams.get('path');
  return value === null ? '' : value;
}

export function createApp(options: AppOptions): Handler {
  const { files, assets } = options;
  const version = options.version ?? '0.1.0';

  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const started = Date.now();
    const method = req.method ?? 'GET';
    const url = new URL(req.url ?? '/', 'http://localhost');
    const pathname = url.pathname;

    try {
      if (pathname.startsWith('/api/')) cors(req, res);

      if (method === 'OPTIONS' && pathname.startsWith('/api/')) {
        res.writeHead(204);
        res.end();
        return;
      }

      if (pathname === '/api/health') {
        if (method !== 'GET') {
          sendError(res, 405, 'method_not_allowed', 'Use GET.');
          return;
        }
        const health = await files.health();
        sendJson(res, 200, {
          ok: true,
          name: SERVER_NAME,
          version,
          root: health.root,
          maxBytes: health.maxBytes,
          readOnly: health.readOnly,
        });
        return;
      }

      if (pathname === '/api/files') {
        if (method === 'GET') {
          sendJson(res, 200, await files.read(queryPath(url)));
          return;
        }
        if (method === 'PUT' || method === 'POST') {
          const body = await readJson(req);
          const result = await files.write(queryPath(url), body['text'], {
            create: method === 'POST' || body['create'] === true,
          });
          sendJson(res, method === 'POST' ? 201 : 200, result);
          return;
        }
        if (method === 'DELETE') {
          sendJson(res, 200, await files.remove(queryPath(url)));
          return;
        }
        sendError(res, 405, 'method_not_allowed', 'Use GET, PUT, POST or DELETE.');
        return;
      }

      if (pathname === '/api/tree') {
        if (method !== 'GET') {
          sendError(res, 405, 'method_not_allowed', 'Use GET.');
          return;
        }
        const tree: TreeResult = await files.tree(queryPath(url) || '.');
        sendJson(res, 200, tree);
        return;
      }

      if (pathname.startsWith('/api/')) {
        sendError(res, 404, 'unknown_endpoint', `No endpoint at ${pathname}.`);
        return;
      }

      if (assets) {
        const served = await serveStatic(req, res, pathname, assets);
        if (served) return;
        if (method !== 'GET' && method !== 'HEAD') {
          sendError(res, 405, 'method_not_allowed', 'Use GET.');
          return;
        }
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not found');
        return;
      }

      sendError(res, 404, 'not_found', 'Nothing is served here.');
      return;
    } catch (error) {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (error instanceof FileServiceError) {
        sendError(res, error.status, error.code, error.message);
        return;
      }
      const message = error instanceof Error ? error.message : 'Unexpected error.';
      sendError(res, 500, 'internal_error', message);
    } finally {
      if (!options.quiet) {
        const status = res.statusCode;
        process.stdout.write(`${method} ${pathname} ${status} ${Date.now() - started}ms\n`);
      }
    }
  };
}
