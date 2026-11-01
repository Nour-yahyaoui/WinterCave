// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_BINDINGS } from '../../src/core/keymap';
import { App } from '../../src/ui/app';

interface Harness {
  app: App;
  host: HTMLElement;
  textarea: HTMLTextAreaElement;
  type(text: string): void;
  press(key: string, init?: KeyboardEventInit): KeyboardEvent;
  overlayText(): string;
  status(): string;
}

let harness: Harness | null = null;

function boot(): Harness {
  document.body.innerHTML = '<div id="app"></div>';
  const host = document.querySelector<HTMLElement>('#app');
  if (!host) throw new Error('host missing');
  const app = new App(host);
  const textarea = host.querySelector<HTMLTextAreaElement>('textarea');
  if (!textarea) throw new Error('textarea missing');

  const type = (text: string) => {
    for (const char of text) {
      textarea.dispatchEvent(
        new InputEvent('beforeinput', {
          inputType: 'insertText',
          data: char,
          bubbles: true,
          cancelable: true,
        }),
      );
    }
  };

  const press = (key: string, init: KeyboardEventInit = {}) => {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
    textarea.dispatchEvent(event);
    return event;
  };

  const overlayText = () =>
    [...host.querySelectorAll('.overlay .line')].map((line) => line.textContent ?? '').join('\n');

  const status = () => host.querySelector('.statusbar')?.textContent ?? '';

  harness = { app, host, textarea, type, press, overlayText, status };
  return harness;
}

beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML = '';
});

describe('shell', () => {
  it('boots with one tab, an empty buffer and a status bar', () => {
    const { host, textarea } = boot();
    expect(host.querySelectorAll('.tab').length).toBe(1);
    expect(textarea.value).toBe('');
    expect(host.querySelector('.statusbar')?.textContent).toContain('Ln 1, Col 1');
    expect(host.querySelector('.brand')?.textContent).toContain('WinterCave');
  });

  it('registers every command the default keymap points at', () => {
    const { app } = boot();
    for (const [combo, commandId] of Object.entries(DEFAULT_BINDINGS)) {
      expect(app.commands.get(commandId), `${combo} -> ${commandId}`).toBeDefined();
    }
  });

  it('shows no dead keybindings for unimplemented commands', () => {
    const { app } = boot();
    const ids = new Set(app.commands.all().map((command) => command.id));
    for (const command of Object.values(DEFAULT_BINDINGS)) expect(ids.has(command)).toBe(true);
  });
});

describe('typing', () => {
  it('inserts characters into the document and the view', () => {
    const { type, textarea, overlayText } = boot();
    type('hello');
    expect(textarea.value).toBe('hello');
    expect(overlayText()).toBe('hello');
  });

  it('keeps the caret after the inserted text', () => {
    const { type, textarea } = boot();
    type('abc');
    expect(textarea.selectionStart).toBe(3);
    expect(textarea.selectionEnd).toBe(3);
  });

  it('auto-closes brackets and puts the caret inside', () => {
    const { type, textarea } = boot();
    type('(');
    expect(textarea.value).toBe('()');
    expect(textarea.selectionStart).toBe(1);
  });

  it('steps over an auto-closed bracket instead of doubling it', () => {
    const { type, textarea } = boot();
    type('(');
    type(')');
    expect(textarea.value).toBe('()');
    expect(textarea.selectionStart).toBe(2);
  });

  it('preserves indentation on Enter', () => {
    const { type, press, textarea } = boot();
    type('    code');
    press('Enter');
    type('x');
    expect(textarea.value).toBe('    code\n    x');
  });

  it('adds an indent level after an opening brace', () => {
    const { type, press, textarea } = boot();
    type('{');
    press('Enter');
    type('x');
    expect(textarea.value).toBe('{\n  x\n}');
  });

  it('inserts spaces on Tab', () => {
    const { press, textarea } = boot();
    press('Tab');
    expect(textarea.value).toBe('  ');
  });

  it('deletes a character on Backspace', () => {
    const { type, press, textarea } = boot();
    type('abc');
    press('Backspace');
    expect(textarea.value).toBe('ab');
  });

  it('handles multi-line pasted text as one edit', () => {
    const { textarea, press, app } = boot();
    textarea.dispatchEvent(
      new ClipboardEvent('paste', {
        clipboardData: { getData: () => 'one\ntwo' } as unknown as DataTransfer,
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(textarea.value).toBe('one\ntwo');
    press('z', { ctrlKey: true });
    expect(textarea.value).toBe('');
    void app;
  });
});

describe('history', () => {
  it('undoes and redoes typing', () => {
    const { type, press, textarea } = boot();
    type('abc');
    press('z', { ctrlKey: true });
    expect(textarea.value).toBe('');
    press('z', { ctrlKey: true, shiftKey: true });
    expect(textarea.value).toBe('abc');
  });

  it('groups a typing burst into a single undo step', () => {
    const { type, press, textarea } = boot();
    type('hello world');
    press('z', { ctrlKey: true });
    expect(textarea.value).toBe('');
  });

  it('does not undo past the beginning', () => {
    const { press, textarea } = boot();
    press('z', { ctrlKey: true });
    expect(textarea.value).toBe('');
  });
});

describe('multi-cursor', () => {
  it('adds a cursor below and types at both', () => {
    const { type, press, textarea, host } = boot();
    type('one');
    press('Enter');
    type('two');
    textarea.setSelectionRange(3, 3);
    textarea.dispatchEvent(new Event('select'));
    press('ArrowDown', { ctrlKey: true, altKey: true });
    type('X');
    expect(textarea.value).toBe('oneX\ntwoX');
    expect(host.querySelector('.statusbar')?.textContent).toContain('2 cursors');
  });

  it('selects the word, then adds the next occurrence', () => {
    const { type, press, textarea } = boot();
    type('foo bar foo');
    textarea.setSelectionRange(0, 0);
    textarea.dispatchEvent(new Event('select'));
    press('d', { ctrlKey: true });
    expect(textarea.selectionStart).toBe(0);
    expect(textarea.selectionEnd).toBe(3);
    press('d', { ctrlKey: true });
    type('X');
    expect(textarea.value).toBe('X bar X');
  });
});

describe('find', () => {
  it('opens, counts matches and jumps between them', () => {
    const { type, press, host } = boot();
    type('alpha beta alpha');
    press('f', { ctrlKey: true });
    const findbar = host.querySelector<HTMLElement>('.findbar');
    expect(findbar?.hidden).toBe(false);

    const query = host.querySelector<HTMLInputElement>('.findbar input');
    if (!query) throw new Error('query input missing');
    query.value = 'alpha';
    query.dispatchEvent(new Event('input', { bubbles: true }));
    expect(host.querySelector('.findbar-count')?.textContent).toBe('1 of 2');

    press('Escape');
    expect(findbar?.hidden).toBe(true);
  });

  it('rejects an invalid regular expression without throwing', () => {
    const { type, press, host } = boot();
    type('abc');
    press('f', { ctrlKey: true });
    const query = host.querySelector<HTMLInputElement>('.findbar input');
    if (!query) throw new Error('query input missing');
    query.value = '(';
    query.dispatchEvent(new Event('input', { bubbles: true }));
    const regexToggle = [...host.querySelectorAll<HTMLButtonElement>('.findbar .toggle')][2];
    regexToggle?.click();
    expect(host.querySelector('.findbar-count')?.textContent).toBe('Invalid pattern');
  });
});

describe('palette', () => {
  it('opens with the keyboard and closes on Escape', () => {
    const { press } = boot();
    press('p', { ctrlKey: true, shiftKey: true });
    expect(document.querySelector('.dialog')).not.toBeNull();
    const input = document.querySelector<HTMLInputElement>('.dialog-input');
    input?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(document.querySelector('.dialog')).toBeNull();
  });

  it('filters commands as you type', () => {
    const { press } = boot();
    press('p', { ctrlKey: true, shiftKey: true });
    const input = document.querySelector<HTMLInputElement>('.dialog-input');
    if (!input) throw new Error('palette input missing');
    input.value = 'wrap';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const titles = [...document.querySelectorAll('.dialog-item-title')].map((node) => node.textContent ?? '');
    expect(titles.length).toBeGreaterThan(0);
    expect(titles.some((title) => /wrap/i.test(title))).toBe(true);
  });
});

describe('view options', () => {
  it('toggles word wrap and line numbers without losing text', () => {
    const { type, press, host, textarea } = boot();
    type('a long line');
    press('p', { ctrlKey: true, shiftKey: true });
    const input = document.querySelector<HTMLInputElement>('.dialog-input');
    if (!input) throw new Error('palette input missing');
    input.value = 'line numbers';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(textarea.value).toBe('a long line');
    expect(host.querySelector('.gutter')).not.toBeNull();
  });
});

describe('durability', () => {
  it('restores the buffer from the session after a reload', async () => {
    const { type } = boot();
    type('# saved work');
    await new Promise((resolve) => setTimeout(resolve, 700));

    document.body.innerHTML = '<div id="app"></div>';
    const host = document.querySelector<HTMLElement>('#app');
    if (!host) throw new Error('host missing');
    new App(host);
    const textarea = host.querySelector<HTMLTextAreaElement>('textarea');
    expect(textarea?.value).toBe('# saved work');
  });

  it('does not restore a buffer the user never typed into', async () => {
    boot();
    await new Promise((resolve) => setTimeout(resolve, 700));
    document.body.innerHTML = '<div id="app"></div>';
    const host = document.querySelector<HTMLElement>('#app');
    if (!host) throw new Error('host missing');
    new App(host);
    expect(host.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('');
  });
});

describe('large documents', () => {
  const bigText = Array.from({ length: 5000 }, (_, index) => `export const value${index} = ${index}; // line`).join('\n');

  const paste = (textarea: HTMLTextAreaElement, text: string) => {
    textarea.dispatchEvent(
      new ClipboardEvent('paste', {
        clipboardData: { getData: () => text } as unknown as DataTransfer,
        bubbles: true,
        cancelable: true,
      }),
    );
  };

  /** Markdown wraps by default; switch to a code language to exercise virtualization. */
  const switchToTypeScript = (host: HTMLElement) => {
    const languageButton = [...host.querySelectorAll<HTMLButtonElement>('.statusbar button')].find(
      (button) => button.textContent === 'Markdown',
    );
    languageButton?.click();
    const row = [...document.querySelectorAll<HTMLElement>('.dialog-item')].find(
      (item) => item.querySelector('.dialog-item-title')?.textContent === 'TypeScript',
    );
    row?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
  };

  it('paints only the viewport of a huge file', () => {
    const { textarea, host } = boot();
    switchToTypeScript(host);
    paste(textarea, bigText);
    expect(textarea.value.length).toBe(bigText.length);
    const rows = host.querySelectorAll('.overlay .line');
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThan(200);
    expect(host.querySelector('.overlay-spacer')).not.toBeNull();
  });

  it('still types and undoes correctly in a huge file', () => {
    const { textarea, type, press, host } = boot();
    switchToTypeScript(host);
    paste(textarea, bigText);
    type('X');
    expect(textarea.value.endsWith('X')).toBe(true);
    press('z', { ctrlKey: true });
    expect(textarea.value).toBe(bigText);
  });

  it('falls back to the plain textarea for very long wrapped documents', () => {
    const { textarea } = boot();
    paste(textarea, bigText);
    // Markdown wraps by default, and 5000 wrapped lines cannot be virtualized.
    const overlay = document.querySelector<HTMLElement>('.overlay');
    expect(overlay?.hidden).toBe(true);
    expect(textarea.value.length).toBe(bigText.length);
    expect(textarea.dataset['wrap']).toBe('true');
  });
});
