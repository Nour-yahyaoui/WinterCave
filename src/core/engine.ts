/**
 * The seam between the web shell and the editor engine.
 *
 * WinterCave's engine is written in Rust (`crates/wintercave-core`, exposed to
 * JavaScript through `crates/wintercave-wasm`). The browser loads that package
 * from `/wasm/` when it has been built with `npm run wasm:build`. When it has
 * not been built — a fresh clone, or someone who simply has no Rust toolchain —
 * the shell falls back to the TypeScript reference implementation in this
 * folder, so nothing breaks and nothing is silently different.
 *
 * Everything that depends on the engine goes through `currentEngine()`. That
 * keeps the choice of implementation in one place and makes it testable without
 * a browser.
 */

import { fuzzyMatch, type FuzzyMatch } from './fuzzy';
import {
  computeNewline,
  decideAutoClose,
  smartHomeTarget,
  type AutoCloseAction,
  type NewlineResult,
} from './smartEdit';

export interface AutoCloseInput {
  char: string;
  before: string;
  after: string;
  hasSelection: boolean;
}

export interface NewlineInput {
  lineText: string;
  column: number;
  indentUnit: string;
}

export interface RankedItem {
  index: number;
  score: number;
  positions: number[];
}

export type EngineKind = 'rust' | 'typescript';

export interface Engine {
  readonly kind: EngineKind;
  readonly version: string;
  autoClose(input: AutoCloseInput): AutoCloseAction | null;
  newline(input: NewlineInput): NewlineResult;
  smartHome(lineText: string, column: number): number;
  fuzzy(query: string, target: string): FuzzyMatch | null;
  /** Rank labels; indices refer to the input array. */
  rank(labels: readonly string[], query: string, limit: number): RankedItem[];
}

/** The subset of the generated wasm package this shell relies on. */
export interface WasmEngineModule {
  version(): string;
  auto_close(
    typed: string,
    before: string,
    after: string,
    hasSelection: boolean,
  ): { type?: string; text?: string; advance?: number; open?: string; close?: string } | undefined;
  newline(lineText: string, column: number, indentUnit: string): ArrayLike<number | string>;
  smart_home(lineText: string, column: number): number;
  fuzzy(query: string, target: string): ArrayLike<number>;
  rank(labels: string[], query: string, limit: number): ArrayLike<number>;
}

/** The TypeScript implementation, used when the Rust package is absent. */
export const typescriptEngine: Engine = {
  kind: 'typescript',
  version: '0.1.0',

  autoClose(input) {
    return decideAutoClose(input);
  },

  newline(input) {
    return computeNewline(input);
  },

  smartHome(lineText, column) {
    return smartHomeTarget(lineText, column);
  },

  fuzzy(query, target) {
    return fuzzyMatch(query, target);
  },

  rank(labels, query, limit) {
    const ranked: RankedItem[] = [];
    labels.forEach((label, index) => {
      const match = fuzzyMatch(query, label);
      if (match) ranked.push({ index, score: match.score, positions: match.positions });
    });
    ranked.sort((a, b) => b.score - a.score || (labels[a.index]?.length ?? 0) - (labels[b.index]?.length ?? 0));
    return ranked.slice(0, limit);
  },
};

/** Adapt the wasm package to the `Engine` interface. */
export function wrapRustEngine(module: WasmEngineModule): Engine {
  const version = module.version();

  return {
    kind: 'rust',
    version,

    autoClose(input) {
      const action = module.auto_close(input.char, input.before, input.after, input.hasSelection);
      if (!action || typeof action.type !== 'string') return null;
      if (action.type === 'insert' && typeof action.text === 'string') {
        return { type: 'insert', text: action.text };
      }
      if (action.type === 'skip' && typeof action.advance === 'number') {
        return { type: 'skip', advance: action.advance };
      }
      if (action.type === 'wrap' && typeof action.open === 'string' && typeof action.close === 'string') {
        return { type: 'wrap', open: action.open, close: action.close };
      }
      return null;
    },

    newline(input) {
      const result = module.newline(input.lineText, input.column, input.indentUnit);
      return { text: String(result[0] ?? ''), caret: Number(result[1] ?? 0) };
    },

    smartHome(lineText, column) {
      return module.smart_home(lineText, column);
    },

    fuzzy(query, target) {
      const packed = module.fuzzy(query, target);
      if (packed.length === 0) return null;
      const score = Number(packed[0] ?? 0);
      const positions: number[] = [];
      for (let index = 1; index < packed.length; index += 1) positions.push(Number(packed[index] ?? 0));
      return { score, positions };
    },

    rank(labels, query, limit) {
      const packed = module.rank([...labels], query, limit);
      const ranked: RankedItem[] = [];
      let cursor = 0;
      while (cursor + 2 < packed.length) {
        const index = Number(packed[cursor] ?? 0);
        const score = Number(packed[cursor + 1] ?? 0);
        const count = Number(packed[cursor + 2] ?? 0);
        cursor += 3;
        const positions: number[] = [];
        for (let offset = 0; offset < count; offset += 1) {
          positions.push(Number(packed[cursor] ?? 0));
          cursor += 1;
        }
        ranked.push({ index, score, positions });
      }
      return ranked;
    },
  };
}

let active: Engine = typescriptEngine;

export function currentEngine(): Engine {
  return active;
}

/** Swap the engine (tests use this; the app uses `loadRustEngine`). */
export function setActiveEngine(engine: Engine | null): void {
  active = engine ?? typescriptEngine;
}

/** Where `npm run wasm:build` puts the package. */
export const WASM_SPECIFIER = '/wasm/wintercave_core.js';

async function importWasmPackage(specifier: string): Promise<WasmEngineModule> {
  const loaded = (await import(/* @vite-ignore */ specifier)) as {
    default?: () => Promise<unknown> | unknown;
  } & Partial<WasmEngineModule>;

  if (typeof loaded.default === 'function') await loaded.default();
  if (typeof loaded.version !== 'function') throw new Error('package does not export the engine');
  return loaded as WasmEngineModule;
}

export interface LoadOptions {
  /** Injection point for tests; defaults to the built package. */
  load?: () => Promise<WasmEngineModule>;
  specifier?: string;
  setActive?: boolean;
  onError?: (error: unknown) => void;
}

/**
 * Try to start on the Rust engine. Never throws: a missing or broken package is
 * a normal state, not an error the editor should die from.
 */
export async function loadRustEngine(options: LoadOptions = {}): Promise<Engine | null> {
  try {
    const module = await (options.load
      ? options.load()
      : importWasmPackage(options.specifier ?? WASM_SPECIFIER));
    const engine = wrapRustEngine(module);
    if (options.setActive !== false) active = engine;
    return engine;
  } catch (error) {
    options.onError?.(error);
    return null;
  }
}

export function engineLabel(engine: Engine = active): string {
  return engine.kind === 'rust' ? `rust ${engine.version}` : 'typescript';
}
