import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { HelpRequested, parseArgs, startServer, type RunningServer } from '../../server/index.ts';

interface Fixture {
  workspace: string;
  dist: string;
  cleanup(): Promise<void>;
}

async function makeFixture(): Promise<Fixture> {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'wintercave-server-'));
  const workspace = path.join(base, 'workspace');
  const dist = path.join(base, 'dist');

  await fsp.mkdir(path.join(workspace, 'sub', 'dir'), { recursive: true });
  await fsp.mkdir(path.join(dist, 'assets'), { recursive: true });
  await fsp.mkdir(path.join(base, 'outside'), { recursive: true });

  await fsp.writeFile(path.join(workspace, 'notes.md'), '# hello\n\nworld\n');
  await fsp.writeFile(path.join(workspace, 'crlf.txt'), 'a\r\nb\r\n');
  await fsp.writeFile(path.join(workspace, 'sub', 'dir', 'deep.txt'), 'deep\n');
  await fsp.writeFile(path.join(workspace, 'image.bin'), Buffer.from([0x89, 0x50, 0x4e, 0x00, 0xff]));
  await fsp.writeFile(path.join(base, 'outside', 'secret.txt'), 'top secret\n');
  await fsp.writeFile(path.join(dist, 'index.html'), '<!doctype html><title>wintercave</title>');
  await fsp.writeFile(path.join(dist, 'assets', 'app.js'), 'console.log("hi");');

  return {
    workspace,
    dist,
    cleanup: () => fsp.rm(base, { recursive: true, force: true }),
  };
}

describe('wintercave server', () => {
  let fixture: Fixture;
  let running: RunningServer;
  let base: string;

  const url = (suffix: string): string => `${base}${suffix}`;
  const readJson = async (response: Response): Promise<Record<string, unknown>> =>
    (await response.json()) as Record<string, unknown>;

  beforeAll(async () => {
    fixture = await makeFixture();
    running = await startServer(
      {
        port: 0,
        host: '127.0.0.1',
        root: fixture.workspace,
        dist: fixture.dist,
        readOnly: false,
        maxBytes: 4096,
      },
      () => undefined,
    );
    base = `http://127.0.0.1:${running.port}`;
  });

  afterAll(async () => {
    await running?.close();
    await fixture?.cleanup();
  });

  it('reports health and confines itself to the workspace', async () => {
    const response = await fetch(url('/api/health'));
    expect(response.status).toBe(200);
    const body = await readJson(response);
    expect(body['ok']).toBe(true);
    expect(body['name']).toBe('wintercave-server');
    expect(body['root']).toBe(path.resolve(fixture.workspace));
    expect(body['maxBytes']).toBe(4096);
    expect(body['readOnly']).toBe(false);
  });

  it('reads a text file', async () => {
    const response = await fetch(url('/api/files?path=notes.md'));
    expect(response.status).toBe(200);
    const body = await readJson(response);
    expect(body['text']).toBe('# hello\n\nworld\n');
    expect(body['name']).toBe('notes.md');
    expect(body['lineEnding']).toBe('lf');
    expect(body['size']).toBe(15);
  });

  it('preserves CRLF line endings', async () => {
    const body = await readJson(await fetch(url('/api/files?path=crlf.txt')));
    expect(body['text']).toBe('a\r\nb\r\n');
    expect(body['lineEnding']).toBe('crlf');
  });

  it('reads nested paths', async () => {
    const body = await readJson(await fetch(url('/api/files?path=sub/dir/deep.txt')));
    expect(body['text']).toBe('deep\n');
  });

  it('answers 404 for a missing file', async () => {
    const response = await fetch(url('/api/files?path=nope.txt'));
    expect(response.status).toBe(404);
    const body = await readJson(response);
    expect((body['error'] as Record<string, unknown>)['code']).toBe('not_found');
  });

  it('refuses to walk out of the workspace', async () => {
    for (const attempt of ['../outside/secret.txt', '..%2foutside%2fsecret.txt', '/etc/passwd']) {
      const response = await fetch(url(`/api/files?path=${attempt}`));
      expect(response.status, attempt).toBe(400);
      const body = await readJson(response);
      expect((body['error'] as Record<string, unknown>)['code'], attempt).toBe('bad_path');
    }
  });

  it('refuses binary files instead of mangling them', async () => {
    const response = await fetch(url('/api/files?path=image.bin'));
    expect(response.status).toBe(415);
  });

  it('writes a file atomically and leaves no temp files behind', async () => {
    const response = await fetch(url('/api/files?path=notes.md'), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: '# hello\n\nrewritten\n' }),
    });
    expect(response.status).toBe(200);
    const body = await readJson(response);
    expect(body['size']).toBe(19);

    const onDisk = await fsp.readFile(path.join(fixture.workspace, 'notes.md'), 'utf8');
    expect(onDisk).toBe('# hello\n\nrewritten\n');

    const leftovers = (await fsp.readdir(fixture.workspace)).filter((name) => name.endsWith('.tmp'));
    expect(leftovers).toEqual([]);
  });

  it('keeps the last complete write when several race', async () => {
    const writes = ['one', 'two', 'three', 'four', 'five'].map((text) =>
      fetch(url('/api/files?path=race.txt'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      }),
    );
    const responses = await Promise.all(writes);
    expect(responses.every((response) => response.status === 201)).toBe(true);

    const final = await fsp.readFile(path.join(fixture.workspace, 'race.txt'), 'utf8');
    expect(['one', 'two', 'three', 'four', 'five']).toContain(final);
    const leftovers = (await fsp.readdir(fixture.workspace)).filter((name) => name.endsWith('.tmp'));
    expect(leftovers).toEqual([]);
  });

  it('requires an explicit create for new files', async () => {
    const missing = await fetch(url('/api/files?path=fresh.txt'), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'x' }),
    });
    expect(missing.status).toBe(404);

    const created = await fetch(url('/api/files?path=fresh.txt'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'x' }),
    });
    expect(created.status).toBe(201);
    expect(await fsp.readFile(path.join(fixture.workspace, 'fresh.txt'), 'utf8')).toBe('x');
  });

  it('creates missing directories for new files', async () => {
    const response = await fetch(url('/api/files?path=new/nested/file.ts'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'export const x = 1;\n' }),
    });
    expect(response.status).toBe(201);
    const written = await fsp.readFile(path.join(fixture.workspace, 'new/nested/file.ts'), 'utf8');
    expect(written).toBe('export const x = 1;\n');
  });

  it('rejects writes over the size limit', async () => {
    const response = await fetch(url('/api/files?path=big.txt'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'x'.repeat(5000) }),
    });
    expect(response.status).toBe(413);
  });

  it('rejects malformed JSON and wrong shapes', async () => {
    const malformed = await fetch(url('/api/files?path=notes.md'), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: '{not json',
    });
    expect(malformed.status).toBe(400);

    const wrongShape = await fetch(url('/api/files?path=notes.md'), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 42 }),
    });
    expect(wrongShape.status).toBe(400);
  });

  it('lists a directory with folders first', async () => {
    const body = await readJson(await fetch(url('/api/tree?path=.')));
    const entries = body['entries'] as { name: string; type: string }[];
    expect(entries[0]?.type).toBe('dir');
    expect(entries.map((entry) => entry.name)).toContain('notes.md');
    expect(entries.map((entry) => entry.name)).not.toContain('.git');
  });

  it('deletes files', async () => {
    const response = await fetch(url('/api/files?path=fresh.txt'), { method: 'DELETE' });
    expect(response.status).toBe(200);
    await expect(fsp.stat(path.join(fixture.workspace, 'fresh.txt'))).rejects.toThrow();

    const again = await fetch(url('/api/files?path=fresh.txt'), { method: 'DELETE' });
    expect(again.status).toBe(404);
  });

  it('serves the built app with sane headers', async () => {
    const index = await fetch(url('/'));
    expect(index.status).toBe(200);
    expect(index.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(index.headers.get('x-content-type-options')).toBe('nosniff');
    expect(index.headers.get('cache-control')).toBe('no-cache');
    expect(await index.text()).toContain('wintercave');

    const asset = await fetch(url('/assets/app.js'));
    expect(asset.status).toBe(200);
    expect(asset.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(asset.headers.get('cache-control')).toContain('immutable');
  });

  it('falls back to index.html for extension-less deep links', async () => {
    const response = await fetch(url('/some/deep/link'));
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('wintercave');
  });

  it('does not fall back for missing assets', async () => {
    const response = await fetch(url('/assets/missing.js'));
    expect(response.status).toBe(404);
  });

  it('rejects unknown API endpoints and methods', async () => {
    const unknown = await fetch(url('/api/nope'));
    expect(unknown.status).toBe(404);

    const wrongMethod = await fetch(url('/api/files?path=notes.md'), { method: 'PATCH' });
    expect(wrongMethod.status).toBe(405);
  });

  it('answers preflight requests', async () => {
    const response = await fetch(url('/api/files'), { method: 'OPTIONS' });
    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('returns ETags and honours them', async () => {
    const first = await fetch(url('/assets/app.js'));
    const etag = first.headers.get('etag');
    expect(etag).toBeTruthy();
    const second = await fetch(url('/assets/app.js'), { headers: { 'If-None-Match': etag ?? '' } });
    expect(second.status).toBe(304);
  });
});

describe('read-only mode', () => {
  let fixture: Fixture;
  let running: RunningServer;

  beforeAll(async () => {
    fixture = await makeFixture();
    running = await startServer(
      {
        port: 0,
        host: '127.0.0.1',
        root: fixture.workspace,
        dist: null,
        readOnly: true,
        maxBytes: 4096,
      },
      () => undefined,
    );
  });

  afterAll(async () => {
    await running?.close();
    await fixture?.cleanup();
  });

  it('still reads', async () => {
    const response = await fetch(`http://127.0.0.1:${running.port}/api/files?path=notes.md`);
    expect(response.status).toBe(200);
  });

  it('refuses writes and deletes with 403', async () => {
    const write = await fetch(`http://127.0.0.1:${running.port}/api/files?path=notes.md`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'nope' }),
    });
    expect(write.status).toBe(403);

    const remove = await fetch(`http://127.0.0.1:${running.port}/api/files?path=notes.md`, {
      method: 'DELETE',
    });
    expect(remove.status).toBe(403);
  });

  it('serves nothing but the API when dist is disabled', async () => {
    const response = await fetch(`http://127.0.0.1:${running.port}/`);
    expect(response.status).toBe(404);
  });
});

describe('argument parsing', () => {
  it('has useful defaults', () => {
    const config = parseArgs([], {});
    expect(config.port).toBe(4173);
    expect(config.host).toBe('0.0.0.0');
    expect(config.root).toBe('.');
    expect(config.dist).toBe('dist');
    expect(config.readOnly).toBe(false);
  });

  it('reads environment variables', () => {
    const config = parseArgs([], { PORT: '8080', HOST: '127.0.0.1', WINTERCAVE_ROOT: '/tmp/x' });
    expect(config.port).toBe(8080);
    expect(config.host).toBe('127.0.0.1');
    expect(config.root).toBe('/tmp/x');
  });

  it('reads flags, in both spellings', () => {
    const config = parseArgs(['--port=9000', '--root', 'work', '--no-dist', '--read-only'], {});
    expect(config.port).toBe(9000);
    expect(config.root).toBe('work');
    expect(config.dist).toBeNull();
    expect(config.readOnly).toBe(true);
  });

  it('rejects nonsense', () => {
    expect(() => parseArgs(['--port', 'abc'], {})).toThrow();
    expect(() => parseArgs(['--wat'], {})).toThrow();
    expect(() => parseArgs(['--help'], {})).toThrow(HelpRequested);
  });
});
