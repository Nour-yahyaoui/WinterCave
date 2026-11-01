import { afterEach, describe, expect, it } from 'vitest';

import {
  currentEngine,
  engineLabel,
  loadRustEngine,
  setActiveEngine,
  typescriptEngine,
  wrapRustEngine,
  type WasmEngineModule,
} from '../../src/core/engine';

/** A stand-in for the wasm package: same shapes, no WebAssembly. */
function fakeModule(overrides: Partial<WasmEngineModule> = {}): WasmEngineModule {
  return {
    version: () => '0.1.0',
    auto_close: () => undefined,
    newline: () => ['\n  ', 3],
    smart_home: () => 2,
    fuzzy: () => [],
    rank: () => [],
    ...overrides,
  };
}

afterEach(() => {
  setActiveEngine(null);
});

describe('the TypeScript engine', () => {
  it('decides auto-close the way the reference core does', () => {
    expect(typescriptEngine.autoClose({ char: '(', before: ' ', after: ' ', hasSelection: false })).toEqual({
      type: 'insert',
      text: '()',
    });
    expect(typescriptEngine.autoClose({ char: ')', before: '(', after: ')', hasSelection: false })).toEqual({
      type: 'skip',
      advance: 1,
    });
    expect(typescriptEngine.autoClose({ char: '(', before: '', after: '', hasSelection: true })).toEqual({
      type: 'wrap',
      open: '(',
      close: ')',
    });
    expect(typescriptEngine.autoClose({ char: '(', before: 'a', after: 'b', hasSelection: false })).toBeNull();
  });

  it('computes newlines and smart home', () => {
    expect(typescriptEngine.newline({ lineText: '  {}', column: 3, indentUnit: '  ' })).toEqual({
      text: '\n    \n  ',
      caret: 5,
    });
    expect(typescriptEngine.smartHome('    code', 8)).toBe(4);
  });

  it('ranks labels by score and length', () => {
    const ranked = typescriptEngine.rank(['file.saveAs', 'file.save', 'edit.toggle'], 'save', 10);
    expect(ranked.map((entry) => entry.index)).toEqual([1, 0]);
    expect(ranked[0]?.positions.length).toBeGreaterThan(0);
    expect(typescriptEngine.rank(['abc'], 'zzz', 10)).toEqual([]);
  });

  it('is the default engine', () => {
    expect(currentEngine()).toBe(typescriptEngine);
    expect(engineLabel()).toBe('typescript');
  });
});

describe('the wasm adapter', () => {
  it('reports the engine version', () => {
    const engine = wrapRustEngine(fakeModule());
    expect(engine.kind).toBe('rust');
    expect(engine.version).toBe('0.1.0');
    expect(engineLabel(engine)).toBe('rust 0.1.0');
  });

  it('maps every auto-close action', () => {
    const engine = wrapRustEngine(
      fakeModule({
        auto_close: (typed) => {
          if (typed === '(') return { type: 'insert', text: '()' };
          if (typed === ')') return { type: 'skip', advance: 1 };
          if (typed === '[') return { type: 'wrap', open: '[', close: ']' };
          if (typed === '{') return { type: 'unknown' };
          return undefined;
        },
      }),
    );

    expect(engine.autoClose({ char: '(', before: '', after: '', hasSelection: false })).toEqual({
      type: 'insert',
      text: '()',
    });
    expect(engine.autoClose({ char: ')', before: '', after: '', hasSelection: false })).toEqual({
      type: 'skip',
      advance: 1,
    });
    expect(engine.autoClose({ char: '[', before: '', after: '', hasSelection: true })).toEqual({
      type: 'wrap',
      open: '[',
      close: ']',
    });
    expect(engine.autoClose({ char: '{', before: '', after: '', hasSelection: false })).toBeNull();
    expect(engine.autoClose({ char: 'x', before: '', after: '', hasSelection: false })).toBeNull();
  });

  it('reads the newline tuple and smart home', () => {
    const engine = wrapRustEngine(fakeModule({ newline: () => ['\n    ', 5], smart_home: () => 7 }));
    expect(engine.newline({ lineText: 'a', column: 1, indentUnit: '  ' })).toEqual({ text: '\n    ', caret: 5 });
    expect(engine.smartHome('        x', 9)).toBe(7);
  });

  it('unpacks fuzzy scores and positions', () => {
    const engine = wrapRustEngine(
      fakeModule({
        fuzzy: (query) => (query === 'sp' ? [42, 0, 4] : []),
      }),
    );
    expect(engine.fuzzy('sp', 'src/palette.ts')).toEqual({ score: 42, positions: [0, 4] });
    expect(engine.fuzzy('zzz', 'src/palette.ts')).toBeNull();
  });

  it('unpacks ranked rows, positions and all', () => {
    const engine = wrapRustEngine(
      fakeModule({
        rank: (_labels, query) => (query === 'save' ? [1, 30, 2, 5, 6, 0, 20, 1, 5] : []),
      }),
    );
    expect(engine.rank(['file.saveAs', 'file.save'], 'save', 10)).toEqual([
      { index: 1, score: 30, positions: [5, 6] },
      { index: 0, score: 20, positions: [5] },
    ]);
    expect(engine.rank(['a'], 'nothing', 10)).toEqual([]);
  });
});

describe('loading the Rust engine', () => {
  it('activates the wasm engine when the package loads', async () => {
    const engine = await loadRustEngine({ load: async () => fakeModule() });
    expect(engine?.kind).toBe('rust');
    expect(currentEngine()).toBe(engine);
    expect(engineLabel()).toBe('rust 0.1.0');
  });

  it('can load without taking over', async () => {
    const engine = await loadRustEngine({ load: async () => fakeModule(), setActive: false });
    expect(engine?.kind).toBe('rust');
    expect(currentEngine()).toBe(typescriptEngine);
  });

  it('falls back quietly when the package is missing', async () => {
    const failures: unknown[] = [];
    const engine = await loadRustEngine({
      load: async () => {
        throw new Error('404 /wasm/wintercave_core.js');
      },
      onError: (error) => failures.push(error),
    });
    expect(engine).toBeNull();
    expect(failures).toHaveLength(1);
    expect(currentEngine()).toBe(typescriptEngine);
  });

  it('rejects a package that is not the engine', async () => {
    const engine = await loadRustEngine({
      load: async () => ({ version: 'nope' }) as unknown as WasmEngineModule,
    });
    expect(engine).toBeNull();
    expect(currentEngine().kind).toBe('typescript');
  });
});
