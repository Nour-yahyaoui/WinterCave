import { clear, el, escapeHtml } from './dom';

export interface PaletteItem {
  id: string;
  label: string;
  category?: string;
  keys?: string;
  description?: string;
  /** Character positions to emphasise (from the fuzzy matcher). */
  positions?: readonly number[];
}

export interface PaletteOptions {
  label: string;
  placeholder?: string;
  initialValue?: string;
  /** Return the ranked items for the current query. */
  filter?: (query: string) => PaletteItem[];
  onSelect?: (item: PaletteItem) => void;
  /** Input mode: Enter hands back the raw value instead of a list selection. */
  onSubmit?: (value: string) => void;
  onClose?: () => void;
}

function highlight(label: string, positions: readonly number[] | undefined): string {
  if (!positions || positions.length === 0) return escapeHtml(label);
  const marked = new Set(positions);
  let html = '';
  for (let index = 0; index < label.length; index += 1) {
    const char = escapeHtml(label[index] ?? '');
    html += marked.has(index) ? `<span class="match-highlight">${char}</span>` : char;
  }
  return html;
}

/**
 * One dialog serves three jobs: command palette, quick open and single-line
 * input (go to line). Sharing it keeps the keyboard model identical.
 */
export class Palette {
  private scrim: HTMLElement | null = null;
  private input: HTMLInputElement | null = null;
  private list: HTMLElement | null = null;
  private items: PaletteItem[] = [];
  private active = 0;
  private options: PaletteOptions | null = null;
  private previouslyFocused: HTMLElement | null = null;

  get isOpen(): boolean {
    return this.scrim !== null;
  }

  open(options: PaletteOptions): void {
    this.close();
    this.options = options;
    this.previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    const input = el('input', {
      class: 'dialog-input',
      type: 'text',
      placeholder: options.placeholder ?? '',
      value: options.initialValue ?? '',
      spellcheck: 'false',
      autocomplete: 'off',
      'aria-label': options.label,
      role: 'combobox',
      'aria-expanded': 'true',
      'aria-controls': 'palette-list',
      'aria-autocomplete': 'list',
    });
    this.input = input;

    const list = el('ul', { class: 'dialog-list', id: 'palette-list', role: 'listbox' });
    this.list = list;

    const dialog = el('div', { class: 'dialog', role: 'dialog', 'aria-label': options.label }, [
      el('div', { class: 'dialog-label', text: options.label }),
      input,
      list,
    ]);

    const scrim = el('div', { class: 'scrim' }, [dialog]);
    this.scrim = scrim;
    document.body.append(scrim);

    scrim.addEventListener('pointerdown', (event) => {
      if (event.target === scrim) this.close();
    });

    input.addEventListener('input', () => this.refresh());
    input.addEventListener('keydown', (event) => this.onKeyDown(event));

    input.value = options.initialValue ?? '';
    this.refresh();
    input.select();
    input.focus({ preventScroll: true });
  }

  close(): void {
    if (!this.scrim) return;
    this.scrim.remove();
    this.scrim = null;
    this.input = null;
    this.list = null;
    this.items = [];
    this.options = null;
    const previous = this.previouslyFocused;
    this.previouslyFocused = null;
    if (previous && previous.isConnected) previous.focus({ preventScroll: true });
  }

  private refresh(): void {
    const options = this.options;
    const input = this.input;
    const list = this.list;
    if (!options || !input || !list) return;

    if (!options.filter) {
      list.hidden = true;
      this.items = [];
      return;
    }

    this.items = options.filter(input.value);
    this.active = 0;
    clear(list);
    if (this.items.length === 0) {
      list.append(el('li', { class: 'dialog-empty', text: 'No matching results' }));
      return;
    }

    this.items.forEach((item, index) => {
      const row = el(
        'li',
        {
          class: 'dialog-item',
          role: 'option',
          id: `palette-item-${index}`,
          'data-active': index === this.active ? 'true' : 'false',
          'aria-selected': index === this.active ? 'true' : 'false',
        },
        [
          el('span', { class: 'dialog-item-title' }),
          item.category ? el('span', { class: 'dialog-item-category', text: item.category }) : null,
          item.keys ? el('span', { class: 'dialog-item-keys', text: item.keys }) : null,
        ],
      );
      const title = row.querySelector('.dialog-item-title');
      if (title) title.innerHTML = highlight(item.label, item.positions);
      row.addEventListener('pointerdown', (event) => {
        event.preventDefault();
        this.select(index);
      });
      row.addEventListener('pointermove', () => {
        if (this.active === index) return;
        this.active = index;
        this.paintActive();
      });
      list.append(row);
    });

    this.paintActive();
  }

  private paintActive(): void {
    const list = this.list;
    if (!list) return;
    const rows = [...list.querySelectorAll<HTMLElement>('.dialog-item')];
    for (const [index, row] of rows.entries()) {
      const active = index === this.active;
      row.dataset['active'] = active ? 'true' : 'false';
      row.setAttribute('aria-selected', active ? 'true' : 'false');
      if (active) {
        try {
          row.scrollIntoView({ block: 'nearest' });
        } catch {
          /* older engines lack scrollIntoView options */
        }
      }
    }
    if (this.input) {
      const activeRow = rows[this.active];
      this.input.setAttribute('aria-activedescendant', activeRow?.id ?? '');
    }
  }

  private select(index: number): void {
    const options = this.options;
    const item = this.items[index];
    if (!options || !item) return;
    this.close();
    options.onSelect?.(item);
  }

  private onKeyDown(event: KeyboardEvent): void {
    const options = this.options;
    if (!options) return;
    switch (event.key) {
      case 'Escape':
        event.preventDefault();
        event.stopPropagation();
        this.close();
        options.onClose?.();
        break;
      case 'ArrowDown':
        event.preventDefault();
        if (this.items.length > 0) {
          this.active = (this.active + 1) % this.items.length;
          this.paintActive();
        }
        break;
      case 'ArrowUp':
        event.preventDefault();
        if (this.items.length > 0) {
          this.active = (this.active - 1 + this.items.length) % this.items.length;
          this.paintActive();
        }
        break;
      case 'Enter':
        event.preventDefault();
        if (options.onSubmit) {
          const value = this.input?.value ?? '';
          this.close();
          options.onSubmit(value);
        } else {
          this.select(this.active);
        }
        break;
      default:
        break;
    }
  }
}
