#!/usr/bin/env node
/**
 * Build the Rust editor engine to WebAssembly and drop the package into
 * `public/wasm/`, where the web shell looks for it at runtime.
 *
 * Requires a Rust toolchain:
 *
 *   rustup target add wasm32-unknown-unknown
 *   cargo install wasm-bindgen-cli --version 0.2.100
 *   npm run wasm:build
 *
 * Without these the shell still runs — it falls back to the TypeScript
 * reference implementation in `src/core`.
 */

import { execFileSync } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(root, 'public', 'wasm');
const OUT_NAME = 'wintercave_core';
const TARGET = 'wasm32-unknown-unknown';

function run(command, args) {
  process.stdout.write(`\n$ ${command} ${args.join(' ')}\n`);
  execFileSync(command, args, { cwd: root, stdio: 'inherit' });
}

function hasCommand(command) {
  try {
    execFileSync(command, ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

if (!hasCommand('cargo')) {
  process.stderr.write(
    'cargo was not found. Install Rust from https://rustup.rs, then run this again.\n' +
      'The editor works without it: the shell falls back to the TypeScript core.\n',
  );
  process.exit(1);
}

if (!hasCommand('wasm-bindgen')) {
  process.stderr.write(
    'wasm-bindgen-cli was not found. Install it with:\n' +
      '  cargo install wasm-bindgen-cli --version 0.2.100\n',
  );
  process.exit(1);
}

await fsp.mkdir(OUT_DIR, { recursive: true });

run('cargo', ['build', '--release', '--target', TARGET, '-p', 'wintercave-wasm']);
run('wasm-bindgen', [
  '--target',
  'web',
  '--out-dir',
  path.relative(root, OUT_DIR),
  '--out-name',
  OUT_NAME,
  path.join(root, 'target', TARGET, 'release', 'wintercave_wasm.wasm'),
]);

const entries = await fsp.readdir(OUT_DIR);
const sizes = await Promise.all(
  entries.map(async (entry) => {
    const stats = await fsp.stat(path.join(OUT_DIR, entry));
    return `${String(stats.size).padStart(9)}  public/wasm/${entry}`;
  }),
);
process.stdout.write(`\nBuilt the Rust engine:\n${sizes.join('\n')}\n`);
