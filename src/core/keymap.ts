export interface KeyEventLike {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
}

const NAMED_KEYS: Record<string, string> = {
  esc: 'Escape',
  escape: 'Escape',
  enter: 'Enter',
  return: 'Enter',
  space: 'Space',
  spacebar: 'Space',
  'space ': 'Space',
  tab: 'Tab',
  backspace: 'Backspace',
  del: 'Delete',
  delete: 'Delete',
  ins: 'Insert',
  insert: 'Insert',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  arrowup: 'ArrowUp',
  arrowdown: 'ArrowDown',
  arrowleft: 'ArrowLeft',
  arrowright: 'ArrowRight',
  up: 'ArrowUp',
  down: 'ArrowDown',
  left: 'ArrowLeft',
  right: 'ArrowRight',
};

const MODIFIERS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'AltGraph', 'OS']);
const MODIFIER_ORDER = ['Mod', 'Ctrl', 'Meta', 'Alt', 'Shift'];

export function isMacPlatform(userAgent?: string): boolean {
  const ua = userAgent ?? (typeof navigator === 'undefined' ? '' : navigator.userAgent);
  return /Mac|iPhone|iPad|iPod/i.test(ua);
}

function canonicalKey(raw: string): string {
  if (raw.length === 1) return raw.toLowerCase();
  const named = NAMED_KEYS[raw.toLowerCase()];
  if (named) return named;
  return raw;
}

/** Canonical form so `shift+mod+p`, `Mod+Shift+P` and `Mod+Shift+p` agree. */
export function normalizeCombo(combo: string): string {
  const parts = combo.split('+').filter((part) => part.length > 0);
  if (parts.length === 0) return '';
  const key = canonicalKey(parts[parts.length - 1] ?? '');
  const modifiers = new Set<string>();
  for (const part of parts.slice(0, -1)) {
    const lower = part.toLowerCase();
    if (lower === 'mod' || lower === 'cmd' || lower === 'command' || lower === 'meta') {
      modifiers.add(lower === 'mod' ? 'Mod' : lower === 'cmd' || lower === 'command' ? 'Mod' : 'Meta');
    } else if (lower === 'ctrl' || lower === 'control') {
      modifiers.add('Ctrl');
    } else if (lower === 'alt' || lower === 'option' || lower === 'opt') {
      modifiers.add('Alt');
    } else if (lower === 'shift') {
      modifiers.add('Shift');
    }
  }
  const ordered = MODIFIER_ORDER.filter((modifier) => modifiers.has(modifier));
  return [...ordered, key].join('+');
}

export function comboFromEvent(event: KeyEventLike, isMac: boolean): string {
  if (MODIFIERS.has(event.key)) return '';
  const modifiers: string[] = [];
  if (isMac) {
    if (event.metaKey) modifiers.push('Mod');
    if (event.ctrlKey) modifiers.push('Ctrl');
  } else {
    if (event.ctrlKey) modifiers.push('Mod');
    if (event.metaKey) modifiers.push('Meta');
  }
  if (event.altKey) modifiers.push('Alt');
  if (event.shiftKey) modifiers.push('Shift');
  const key = canonicalKey(event.key);
  return [...modifiers, key].join('+');
}

export type Keymap = Record<string, string>;

/**
 * Defaults follow VS Code / Sublime where a convention exists. Novel bindings
 * cost users real time, so we only invent one when there's nothing to match.
 */
export const DEFAULT_BINDINGS: Keymap = {
  'Mod+n': 'file.new',
  'Mod+o': 'file.open',
  'Mod+s': 'file.save',
  'Mod+Shift+s': 'file.saveAs',
  'Mod+w': 'file.close',
  'Mod+p': 'palette.quickOpen',
  'Mod+Shift+p': 'palette.commands',
  'F1': 'palette.commands',
  'Mod+f': 'find.open',
  'Mod+h': 'find.replace',
  'Mod+g': 'goto.line',
  'Mod+z': 'history.undo',
  'Mod+Shift+z': 'history.redo',
  'Mod+y': 'history.redo',
  'Mod+a': 'select.all',
  'Mod+d': 'cursor.addNextOccurrence',
  'Mod+Alt+ArrowUp': 'cursor.addAbove',
  'Mod+Alt+ArrowDown': 'cursor.addBelow',
  'Mod+/': 'edit.toggleComment',
  'Alt+ArrowUp': 'edit.moveLineUp',
  'Alt+ArrowDown': 'edit.moveLineDown',
  'Shift+Alt+ArrowDown': 'edit.duplicateLine',
  'Shift+Alt+ArrowUp': 'edit.duplicateLineUp',
  'Mod+Shift+k': 'edit.deleteLine',
  'Mod+]': 'edit.indent',
  'Mod+[': 'edit.outdent',
  'Mod+=': 'view.zoomIn',
  'Mod+-': 'view.zoomOut',
  'Mod+0': 'view.zoomReset',
  'Mod+\\': 'view.splitEditor',
};

export function normalizeKeymap(bindings: Keymap): Keymap {
  const result: Keymap = {};
  for (const [combo, command] of Object.entries(bindings)) {
    const normalized = normalizeCombo(combo);
    if (normalized !== '') result[normalized] = command;
  }
  return result;
}

export function resolveCommand(bindings: Keymap, combo: string): string | undefined {
  if (combo === '') return undefined;
  return bindings[combo] ?? bindings[normalizeCombo(combo)];
}

/** Bindings that map one combo to several commands, or one command to several combos. */
export function findConflicts(bindings: Keymap): { combo: string; commands: string[] }[] {
  const byCombo = new Map<string, Set<string>>();
  for (const [combo, command] of Object.entries(bindings)) {
    const key = normalizeCombo(combo);
    const set = byCombo.get(key) ?? new Set<string>();
    set.add(command);
    byCombo.set(key, set);
  }
  const conflicts: { combo: string; commands: string[] }[] = [];
  for (const [combo, commands] of byCombo) {
    if (commands.size > 1) conflicts.push({ combo, commands: [...commands] });
  }
  return conflicts;
}

/** Human-readable shortcut for menus, adapted to the platform. */
export function formatCombo(combo: string, isMac: boolean): string {
  const parts = normalizeCombo(combo).split('+');
  const key = parts.pop() ?? '';
  const symbols: Record<string, string> = { Mod: isMac ? '⌘' : 'Ctrl', Ctrl: isMac ? '⌃' : 'Ctrl', Meta: '⌘', Alt: isMac ? '⌥' : 'Alt', Shift: isMac ? '⇧' : 'Shift' };
  const named: Record<string, string> = { ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Enter: '↵', Escape: 'Esc', Space: 'Space' };
  return [...parts.map((part) => symbols[part] ?? part), named[key] ?? key].join(isMac ? '' : '+');
}
