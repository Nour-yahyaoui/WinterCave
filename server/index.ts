#!/usr/bin/env node
/**
 * WinterCave's tiny server — deliberately TypeScript and deliberately small.
 *
 *   node --experimental-strip-types server/index.ts --port 4173
 *
 * It does two things: serves the built web shell out of `dist`, and exposes a
 * file API (`/api/files`, `/api/tree`, `/api/health`) confined to `--root`.
 * No framework, no dependencies, no build step of its own.
 */

import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { createApp, SERVER_NAME } from './app.ts';
import { DEFAULT_MAX_BYTES, FileService } from './fileService.ts';
import { packageVersion } from './version.ts';

export interface ServerConfig {
  port: number;
  host: string;
  root: string;
  /** Directory holding the built app, or null to run API-only. */
  dist: string | null;
  readOnly: boolean;
  maxBytes: number;
}

export const USAGE = `WinterCave server

Usage: node --experimental-strip-types server/index.ts [options]

  -p, --port <n>      port to listen on (default 4173, or $PORT)
      --host <addr>   address to bind (default 0.0.0.0, or $HOST)
      --root <dir>    directory the file API may read/write (default .)
      --dist <dir>    built app to serve (default dist)
      --no-dist       API only
      --read-only     refuse writes
      --max-bytes <n> largest file accepted, in bytes
  -h, --help          show this help`;

function numberArg(raw: string | undefined, fallback: number, label: string): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new Error(`${label} must be a positive number`);
  return value;
}

export function parseArgs(
  argv: readonly string[],
  env: Record<string, string | undefined> = process.env,
): ServerConfig {
  const config: ServerConfig = {
    port: numberArg(env['PORT'], 4173, 'port'),
    host: env['HOST'] ?? '0.0.0.0',
    root: env['WINTERCAVE_ROOT'] ?? '.',
    dist: env['WINTERCAVE_DIST'] ?? 'dist',
    readOnly: false,
    maxBytes: DEFAULT_MAX_BYTES,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index] ?? '';
    const [flag, inline] = raw.includes('=') ? raw.split(/=(.*)/s, 2) : [raw, undefined];
    const next = (): string | undefined => {
      if (inline !== undefined) return inline;
      index += 1;
      return argv[index];
    };

    switch (flag) {
      case '-p':
      case '--port':
        config.port = numberArg(next(), config.port, 'port');
        break;
      case '--host':
        config.host = next() ?? config.host;
        break;
      case '--root':
        config.root = next() ?? config.root;
        break;
      case '--dist':
        config.dist = next() ?? config.dist;
        break;
      case '--no-dist':
        config.dist = null;
        break;
      case '--read-only':
        config.readOnly = true;
        break;
      case '--max-bytes':
        config.maxBytes = numberArg(next(), config.maxBytes, 'max-bytes');
        break;
      case '-h':
      case '--help':
        throw new HelpRequested();
      default:
        if (flag !== '') throw new Error(`Unknown option: ${flag}`);
    }
  }

  return config;
}

export class HelpRequested extends Error {
  override readonly name = 'HelpRequested';
}

export interface RunningServer {
  server: http.Server;
  config: ServerConfig;
  /** Actual bound port, useful when the config asked for 0. */
  port: number;
  close(): Promise<void>;
}

export function createServer(config: ServerConfig): http.Server {
  const files = new FileService({
    root: path.resolve(config.root),
    maxBytes: config.maxBytes,
    readOnly: config.readOnly,
  });

  const handler = createApp({
    files,
    version: packageVersion(),
    assets: config.dist === null ? undefined : { directory: path.resolve(config.dist), spaFallback: true },
  });

  return http.createServer((req, res) => {
    void handler(req, res);
  });
}

export async function startServer(
  config: ServerConfig,
  log: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
): Promise<RunningServer> {
  const server = createServer(config);
  await new Promise<void>((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException): void => {
      server.off('listening', onListening);
      reject(
        error.code === 'EADDRINUSE'
          ? new Error(`Port ${config.port} is already in use. Pass --port to pick another one.`)
          : error,
      );
    };
    const onListening = (): void => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(config.port, config.host);
  });

  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : config.port;

  log(`${SERVER_NAME} listening on http://${config.host}:${port}`);
  log(`  files: ${path.resolve(config.root)}${config.readOnly ? ' (read-only)' : ''}`);
  if (config.dist !== null) log(`  app:   ${path.resolve(config.dist)}`);
  else log('  app:   disabled (API only)');

  return {
    server,
    config,
    port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

async function main(): Promise<void> {
  let config: ServerConfig;
  try {
    config = parseArgs(process.argv.slice(2));
  } catch (error) {
    if (error instanceof HelpRequested) {
      process.stdout.write(`${USAGE}\n`);
      return;
    }
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n${USAGE}\n`);
    process.exitCode = 2;
    return;
  }

  try {
    const running = await startServer(config);
    const shutdown = (): void => {
      void running.close().then(() => process.exit(0));
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  } catch (error) {
    process.stderr.write(`wintercave-server: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  void main();
}
