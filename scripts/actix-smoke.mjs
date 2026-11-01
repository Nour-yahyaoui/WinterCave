#!/usr/bin/env node
/**
 * Live HTTP smoke test for the actix server (`crates/wintercave-server`).
 *
 * Unit tests drive the service in-process; this one proves the shipped binary
 * really binds a port, serves the built app and answers the file API over the
 * wire. It starts the server on an ephemeral port, talks to it with `fetch`,
 * and asserts the same JSON contract `server/app.ts` provides.
 *
 *   cargo build -p wintercave-server   # once
 *   npm run smoke:rust
 */

import { execFileSync, spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(await fsp.readFile(path.join(root, 'package.json'), 'utf8'));
const binaryName = process.platform === 'win32' ? 'wintercave-server.exe' : 'wintercave-server';
const binary = path.join(root, 'target', 'debug', binaryName);

let checks = 0;
let failures = 0;

function check(label, condition, detail) {
  checks += 1;
  if (condition) return;
  failures += 1;
  process.stderr.write(`  ✗ ${label}${detail === undefined ? '' : ` — ${detail}`}\n`);
}

function equal(label, actual, expected) {
  check(
    label,
    Object.is(actual, expected),
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
  );
}

try {
  await fsp.access(binary);
} catch {
  process.stdout.write(`building the actix server first:\n  cargo build -p wintercave-server\n`);
  execFileSync('cargo', ['build', '-p', 'wintercave-server'], { cwd: root, stdio: 'inherit' });
}

const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'wintercave-actix-'));
const workspace = path.join(base, 'workspace');
const dist = path.join(base, 'dist');
await fsp.mkdir(workspace, { recursive: true });
await fsp.mkdir(dist, { recursive: true });
await fsp.writeFile(path.join(workspace, 'notes.md'), '# hello\n');
await fsp.writeFile(path.join(workspace, 'crlf.txt'), 'a\r\nb\r\n');
await fsp.writeFile(path.join(dist, 'index.html'), '<!doctype html><title>WinterCave</title>');
await fsp.writeFile(path.join(dist, 'app.js'), 'console.log(1)');

const child = spawn(
  binary,
  ['--port', '0', '--host', '127.0.0.1', '--root', workspace, '--dist', dist],
  { stdio: ['ignore', 'pipe', 'pipe'] },
);

let log = '';
let exited = false;
child.on('exit', () => {
  exited = true;
});

function portFromLog() {
  const match = /listening on http:\/\/[^:\s]+:(\d+)/.exec(log);
  return match ? Number(match[1]) : null;
}

let baseUrl = null;
try {
  child.stdout.on('data', (chunk) => {
    log += chunk;
  });
  child.stderr.on('data', (chunk) => {
    log += chunk;
  });

  const deadline = Date.now() + 20_000;
  while (baseUrl === null) {
    if (exited) throw new Error(`the server exited before listening:\n${log}`);
    if (Date.now() > deadline) throw new Error(`the server never reported a port:\n${log}`);
    const port = portFromLog();
    if (port !== null) baseUrl = `http://127.0.0.1:${port}`;
    else await new Promise((resolve) => setTimeout(resolve, 50));
  }

  process.stdout.write(`server ready at ${baseUrl}\n`);

  const request = (route, options) => fetch(`${baseUrl}${route}`, options);
  const readJson = async (route, options) => {
    const response = await request(route, options);
    return { status: response.status, body: await response.json().catch(() => null), headers: response.headers };
  };

  // --- health ------------------------------------------------------------
  const health = await readJson('/api/health');
  equal('health status', health.status, 200);
  equal('health ok', health.body?.ok, true);
  equal('health name', health.body?.name, 'wintercave-server');
  equal('health version matches package.json', health.body?.version, pkg.version);
  equal('health readOnly', health.body?.readOnly, false);
  equal(
    'health content type',
    health.headers.get('content-type'),
    'application/json; charset=utf-8',
  );
  equal('health cors', health.headers.get('access-control-allow-origin'), '*');

  // --- read --------------------------------------------------------------
  const notes = await readJson('/api/files?path=notes.md');
  equal('read status', notes.status, 200);
  equal('read text', notes.body?.text, '# hello\n');
  equal('read line ending', notes.body?.lineEnding, 'lf');
  equal('read name', notes.body?.name, 'notes.md');

  const crlf = await readJson('/api/files?path=crlf.txt');
  equal('crlf detection', crlf.body?.lineEnding, 'crlf');

  const missing = await readJson('/api/files?path=nope.txt');
  equal('missing status', missing.status, 404);
  equal('missing code', missing.body?.error?.code, 'not_found');

  const traversal = await readJson('/api/files?path=../outside.txt');
  equal('traversal status', traversal.status, 400);
  equal('traversal code', traversal.body?.error?.code, 'bad_path');

  // --- write / create / delete -------------------------------------------
  const written = await readJson('/api/files?path=notes.md', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'rewritten over HTTP\n' }),
  });
  equal('put status', written.status, 200);
  equal(
    'put reached the disk',
    await fsp.readFile(path.join(workspace, 'notes.md'), 'utf8'),
    'rewritten over HTTP\n',
  );

  const created = await readJson('/api/files?path=nested/fresh.txt', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'new\n' }),
  });
  equal('post status', created.status, 201);
  const strictPut = await readJson('/api/files?path=strict.txt', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'x' }),
  });
  equal('put without create is 404', strictPut.status, 404);

  const badJson = await readJson('/api/files?path=notes.md', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: 'not json',
  });
  equal('bad json status', badJson.status, 400);
  equal('bad json code', badJson.body?.error?.code, 'bad_json');

  // --- tree --------------------------------------------------------------
  const tree = await readJson('/api/tree');
  equal('tree status', tree.status, 200);
  const names = (tree.body?.entries ?? []).map((entry) => entry.name);
  check('tree lists the workspace', names.includes('notes.md'), JSON.stringify(names));
  check('tree lists directories first', tree.body?.entries?.[0]?.type === 'dir', names[0]);
  check('tree ignores nothing it should see', names.includes('crlf.txt'));

  const subTree = await readJson('/api/tree?path=nested');
  equal('subtree path', subTree.body?.path, 'nested');

  // --- routing -----------------------------------------------------------
  const unknown = await readJson('/api/nope');
  equal('unknown endpoint status', unknown.status, 404);
  equal('unknown endpoint code', unknown.body?.error?.code, 'unknown_endpoint');

  const wrongMethod = await readJson('/api/tree', { method: 'POST', body: '{}' });
  equal('wrong method status', wrongMethod.status, 405);

  const preflight = await request('/api/files', { method: 'OPTIONS' });
  equal('preflight status', preflight.status, 204);
  equal(
    'preflight methods',
    preflight.headers.get('access-control-allow-methods'),
    'GET, PUT, POST, DELETE, OPTIONS',
  );

  // --- static hosting ----------------------------------------------------
  const index = await request('/');
  equal('index status', index.status, 200);
  check(
    'index content type',
    (index.headers.get('content-type') ?? '').startsWith('text/html'),
    index.headers.get('content-type'),
  );

  const deepLink = await request('/some/deep/link');
  equal('spa fallback', deepLink.status, 200);

  const asset = await request('/app.js');
  equal('asset status', asset.status, 200);
  equal('asset cache control', asset.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  const etag = asset.headers.get('etag');
  check('asset has an etag', typeof etag === 'string' && etag.length > 2, String(etag));

  if (etag) {
    const revalidated = await request('/app.js', { headers: { 'if-none-match': etag } });
    equal('etag revalidation', revalidated.status, 304);
  }

  const missingAsset = await request('/missing.js');
  equal('missing asset status', missingAsset.status, 404);

  // --- delete last, so the tree assertions above stay meaningful ---------
  const deleted = await readJson('/api/files?path=crlf.txt', { method: 'DELETE' });
  equal('delete status', deleted.status, 200);
  check(
    'delete removed the file',
    !(await fsp.access(path.join(workspace, 'crlf.txt')).then(
      () => true,
      () => false,
    )),
  );
} catch (error) {
  failures += 1;
  process.stderr.write(`  ✗ ${error instanceof Error ? error.message : String(error)}\n`);
} finally {
  child.kill('SIGTERM');
  await fsp.rm(base, { recursive: true, force: true });
}

process.stdout.write(
  `\n${checks} checks, ${failures} failure${failures === 1 ? '' : 's'}\n`,
);
if (failures > 0) process.exit(1);
