#!/usr/bin/env node
/**
 * End-to-end check for the WebAssembly engine: load the built package the same
 * way the browser does and exercise the API the web shell uses.
 *
 * Run it after `npm run wasm:build` (CI runs both). It is deliberately strict —
 * a green smoke test means the Rust engine really works from JavaScript.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const glue = path.join(root, 'public', 'wasm', 'wintercave_core.js');
const binary = path.join(root, 'public', 'wasm', 'wintercave_core_bg.wasm');

let failures = 0;
let checks = 0;

function check(label, condition, detail) {
  checks += 1;
  if (condition) return;
  failures += 1;
  process.stderr.write(`  ✗ ${label}${detail === undefined ? '' : ` — ${detail}`}\n`);
}

function equal(label, actual, expected) {
  check(label, Object.is(actual, expected), `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

try {
  await fsp.access(glue);
} catch {
  process.stderr.write('public/wasm is missing. Run `npm run wasm:build` first.\n');
  process.exit(1);
}

const wasm = await import(pathToFileURL(glue).href);
const bytes = await fsp.readFile(binary);

if (typeof wasm.initSync === 'function') {
  wasm.initSync({ module: bytes });
} else {
  await wasm.default({ module_or_path: bytes });
}

const pkg = JSON.parse(await fsp.readFile(path.join(root, 'package.json'), 'utf8'));

process.stdout.write(`engine version: ${wasm.version?.() ?? '(missing version export)'}\n`);

// The wasm engine version comes from Cargo.toml, the package version from
// package.json: they must agree or the release tag lies about what shipped.
equal('version', wasm.version(), pkg.version);
equal('token kind 0', wasm.token_kind_name(0), 'keyword');
equal('token kind 2', wasm.token_kind_name(2), 'comment');
equal('token kind 16', wasm.token_kind_name(16), 'meta');
equal('bogus token kind', wasm.token_kind_name(999), '');
equal('language for filename', wasm.language_for('src/ui/app.ts'), 'typescript');
equal('unknown filename', wasm.language_for('README'), 'plaintext');
check('language catalog', wasm.language_catalog().length === 11, String(wasm.language_catalog().length));

// --- document, tokens, history -------------------------------------------
const engine = new wasm.Engine('const answer = 42;\n// trailing\n', 'typescript');
equal('line count', engine.line_count(), 3);
equal('first line', engine.line_text(0), 'const answer = 42;');
equal('line of offset', engine.line_of(0), 0);
equal('position at', Array.from(engine.position_at(6)).join(','), '0,6');
equal('offset at', engine.offset_at(0, 6), 6);

const tokens = Array.from(engine.tokens(0, 3));
const first = tokens.slice(0, 4);
equal('first token line', first[0], 0);
equal('first token start', first[1], 0);
equal('first token end', first[2], 5);
equal('first token kind', wasm.token_kind_name(first[3]), 'keyword');
check(
  'comment token on line 1',
  (() => {
    for (let index = 0; index + 3 < tokens.length; index += 4) {
      if (tokens[index] === 1 && wasm.token_kind_name(tokens[index + 3]) === 'comment') return true;
    }
    return false;
  })(),
);

engine.insert(0, '> ');
equal('insert', engine.line_text(0), '> const answer = 42;');
equal('can undo', engine.can_undo(), true);
equal('undo returns caret', engine.undo(), 0);
equal('undo restored text', engine.line_text(0), 'const answer = 42;');
equal('can redo', engine.can_redo(), true);
engine.redo();
equal('redo applied', engine.line_text(0), '> const answer = 42;');
engine.remove(0, 2);
equal('remove', engine.line_text(0), 'const answer = 42;');

// --- search and replace ---------------------------------------------------
const matches = Array.from(engine.search('answer', true, false, false));
equal('search hit count', matches.length, 2);
equal('search first match', matches[0], 6);
const replaced = engine.replace_all('answer', 'reply', true, false, false);
equal('replace count', Number(replaced[1]), 1);
equal('replaced text', engine.text().split('\n')[0], 'const reply = 42;');
check('regex error is reported', engine.search_error('(', true).length > 0);

// --- stateless helpers ----------------------------------------------------
equal('fuzzy score present', wasm.fuzzy('sp', 'src/palette.ts').length > 0, true);
check('fuzzy miss', wasm.fuzzy('zzz', 'abc').length === 0);
const ranked = Array.from(wasm.rank(['file.save', 'file.saveAs', 'edit.toggle'], 'save', 10));
check('rank returns rows', ranked.length >= 6, String(ranked.length));
equal('rank best index', ranked[0], 0);

const autoClose = wasm.auto_close('(', '', '', false);
equal('auto close inserts', autoClose?.type, 'insert');
equal('auto close text', autoClose?.text, '()');
equal('auto close skip', wasm.auto_close(')', '(', ')', false)?.type, 'skip');
equal('auto close wraps', wasm.auto_close('(', '', '', true)?.type, 'wrap');
equal('auto close refuses', wasm.auto_close('(', 'a', 'b', false), undefined);

const entered = wasm.newline('  {}', 3, '  ');
equal('newline text', entered[0], '\n    \n  ');
equal('newline caret', Number(entered[1]), 5);
equal('smart home', wasm.smart_home('    code', 8), 4);
const indent = wasm.detect_indentation('a\n    b\n    c', '  ', true);
equal('detected indent', indent[0], '    ');
equal('indent uses spaces', indent[1], true);
const indented = wasm.reindent(['a', 'b'], '  ', true, true);
equal('reindent', Array.from(indented).join('|'), '  a|  b');
const commented = wasm.toggle_comment(['x', '', '  y'], '//');
equal('toggle comment', Array.from(commented).join('|'), '// x||  // y');
equal('toggle comment line', wasm.toggle_comment_line('// x', '//'), 'x');

// --- keymap ---------------------------------------------------------------
equal('normalize combo', wasm.key_normalize('shift+mod+p'), 'Mod+Shift+p');
equal('combo from event', wasm.key_combo('p', true, false, false, true, false), 'Mod+Shift+p');
equal('combo on mac', wasm.key_combo('p', false, true, false, false, true), 'Mod+p');
equal('format combo', wasm.key_format('Mod+Shift+p', false), 'Ctrl+Shift+p');
check('default bindings', wasm.key_defaults().length === 29, String(wasm.key_defaults().length));
const conflicts = wasm.key_conflicts(['Mod+p', 'a', 'mod+P', 'b']);
equal('conflict count', conflicts.length, 1);
equal('conflict combo', conflicts[0]?.combo, 'Mod+p');

// --- limits ---------------------------------------------------------------
const sizes = wasm.size_report(1536, 10);
equal('size class', sizes[0], 'ok');
equal('size label', sizes[1], '1.5 KB');
equal('highlight allowed', sizes[2], true);
equal('refuse class', wasm.size_report(60_000_000, 10)[0], 'refuse');

process.stdout.write(
  failures === 0
    ? `\nwasm engine: ${checks} checks passed\n`
    : `\nwasm engine: ${failures} of ${checks} checks failed\n`,
);
process.exit(failures === 0 ? 0 : 1);
