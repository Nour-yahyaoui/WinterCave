import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BINDINGS,
  comboFromEvent,
  findConflicts,
  formatCombo,
  isMacPlatform,
  normalizeCombo,
  normalizeKeymap,
  resolveCommand,
} from '../../src/core/keymap';

describe('normalizeCombo', () => {
  it('canonicalises modifier order and case', () => {
    expect(normalizeCombo('shift+mod+p')).toBe('Mod+Shift+p');
    expect(normalizeCombo('Mod+Shift+P')).toBe('Mod+Shift+p');
    expect(normalizeCombo('alt+ctrl+x')).toBe('Ctrl+Alt+x');
  });

  it('names arrow and editing keys', () => {
    expect(normalizeCombo('mod+arrowup')).toBe('Mod+ArrowUp');
    expect(normalizeCombo('ctrl+esc')).toBe('Ctrl+Escape');
    expect(normalizeCombo('shift+enter')).toBe('Shift+Enter');
  });

  it('treats cmd and command as the platform modifier', () => {
    expect(normalizeCombo('cmd+s')).toBe('Mod+s');
    expect(normalizeCombo('command+s')).toBe('Mod+s');
    expect(normalizeCombo('meta+s')).toBe('Meta+s');
  });

  it('returns an empty string for empty input', () => {
    expect(normalizeCombo('')).toBe('');
  });
});

describe('comboFromEvent', () => {
  it('maps Ctrl to Mod off macOS', () => {
    expect(comboFromEvent({ key: 'p', ctrlKey: true }, false)).toBe('Mod+p');
    expect(comboFromEvent({ key: 'p', metaKey: true }, false)).toBe('Meta+p');
  });

  it('maps Cmd to Mod on macOS', () => {
    expect(comboFromEvent({ key: 'p', metaKey: true }, true)).toBe('Mod+p');
    expect(comboFromEvent({ key: 'p', ctrlKey: true }, true)).toBe('Ctrl+p');
  });

  it('ignores modifier-only presses', () => {
    expect(comboFromEvent({ key: 'Shift', shiftKey: true }, false)).toBe('');
  });

  it('normalises shifted letters so bindings match regardless of case', () => {
    expect(comboFromEvent({ key: 'P', ctrlKey: true, shiftKey: true }, false)).toBe('Mod+Shift+p');
  });
});

describe('bindings', () => {
  const keymap = normalizeKeymap(DEFAULT_BINDINGS);

  it('resolves the documented defaults', () => {
    expect(resolveCommand(keymap, 'Mod+s')).toBe('file.save');
    expect(resolveCommand(keymap, 'Mod+Shift+p')).toBe('palette.commands');
    expect(resolveCommand(keymap, 'Mod+f')).toBe('find.open');
  });

  it('resolves regardless of the input spelling', () => {
    expect(resolveCommand(keymap, 'mod+shift+P')).toBe('palette.commands');
  });

  it('returns undefined for unbound combos', () => {
    expect(resolveCommand(keymap, 'Mod+Shift+Alt+q')).toBeUndefined();
    expect(resolveCommand(keymap, '')).toBeUndefined();
  });

  it('has no conflicting defaults', () => {
    expect(findConflicts(DEFAULT_BINDINGS)).toEqual([]);
  });

  it('finds conflicts when they exist', () => {
    const conflicts = findConflicts({ 'mod+s': 'file.save', 'Mod+S': 'file.saveAs' });
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.commands.sort()).toEqual(['file.save', 'file.saveAs']);
  });

  it('every default binding points at a command id', () => {
    for (const [, command] of Object.entries(DEFAULT_BINDINGS)) {
      expect(command).toMatch(/^[a-z]+\.[a-zA-Z]+$/);
    }
  });
});

describe('formatCombo', () => {
  it('renders platform-appropriate labels', () => {
    expect(formatCombo('Mod+Shift+p', false)).toBe('Ctrl+Shift+p');
    expect(formatCombo('Mod+Shift+p', true)).toBe('⌘⇧p');
    expect(formatCombo('Alt+ArrowDown', false)).toBe('Alt+↓');
  });
});

describe('isMacPlatform', () => {
  it('detects macOS user agents only', () => {
    expect(isMacPlatform('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')).toBe(true);
    expect(isMacPlatform('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe(false);
    expect(isMacPlatform('')).toBe(false);
  });
});
