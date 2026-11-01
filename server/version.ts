import { readFileSync } from 'node:fs';

/**
 * The version the server reports on `GET /api/health`.
 *
 * Deliberately read from `package.json` instead of being written as a literal:
 * a release bumps one file, and the running server cannot claim a version that
 * does not exist. Resolution is relative to this module, so it works from any
 * working directory.
 */
export function packageVersion(): string {
  try {
    const raw = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === 'string' && parsed.version.length > 0 ? parsed.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}
