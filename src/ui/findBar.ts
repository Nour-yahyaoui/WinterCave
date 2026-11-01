import { el } from './dom';

export interface FindBarState {
  visible: boolean;
  replaceVisible: boolean;
  query: string;
  replacement: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
  /** Total matches, or -1 when the pattern is invalid. */
  count: number;
  activeIndex: number;
  error: string | null;
}

export interface FindBarHandlers {
  onQuery(query: string): void;
  onReplacement(value: string): void;
  onToggle(flag: 'caseSensitive' | 'wholeWord' | 'regex'): void;
  onNext(): void;
  onPrevious(): void;
  onReplace(): void;
  onReplaceAll(): void;
  onClose(): void;
}

const EMPTY_STATE: FindBarState = {
  visible: false,
  replaceVisible: false,
  query: '',
  replacement: '',
  caseSensitive: false,
  wholeWord: false,
  regex: false,
  count: 0,
  activeIndex: -1,
  error: null,
};

/** In-document find/replace. Keyboard-first: Enter next, Shift+Enter previous, Esc closes. */
export class FindBar {
  readonly root: HTMLElement;
  private readonly queryInput: HTMLInputElement;
  private readonly replacementInput: HTMLInputElement;
  private readonly countLabel: HTMLElement;
  private readonly toggles: Record<'caseSensitive' | 'wholeWord' | 'regex', HTMLButtonElement>;
  private readonly replacementRow: HTMLElement;
  private state: FindBarState = EMPTY_STATE;

  constructor(container: HTMLElement, private readonly handlers: FindBarHandlers) {
    this.queryInput = el('input', {
      type: 'text',
      placeholder: 'Find',
      spellcheck: 'false',
      autocomplete: 'off',
      'aria-label': 'Find in document',
    });
    this.replacementInput = el('input', {
      type: 'text',
      placeholder: 'Replace with',
      spellcheck: 'false',
      autocomplete: 'off',
      'aria-label': 'Replace with',
    });
    this.countLabel = el('span', { class: 'findbar-count', role: 'status', 'aria-live': 'polite' });

    this.toggles = {
      caseSensitive: el('button', { class: 'toggle', type: 'button', title: 'Match case (Alt+C)', text: 'Aa' }),
      wholeWord: el('button', { class: 'toggle', type: 'button', title: 'Whole word (Alt+W)', text: 'ab|' }),
      regex: el('button', { class: 'toggle', type: 'button', title: 'Regular expression (Alt+R)', text: '.*' }),
    };

    const nextButton = el('button', { class: 'icon-button', type: 'button', title: 'Next match (Enter)', text: '↓' });
    const previousButton = el('button', { class: 'icon-button', type: 'button', title: 'Previous match (Shift+Enter)', text: '↑' });
    const closeButton = el('button', { class: 'icon-button', type: 'button', title: 'Close (Esc)', text: '×' });
    const replaceButton = el('button', { class: 'button', type: 'button', text: 'Replace' });
    const replaceAllButton = el('button', { class: 'button', type: 'button', text: 'Replace all' });

    this.replacementRow = el('div', { class: 'findbar-row' }, [
      this.replacementInput,
      replaceButton,
      replaceAllButton,
    ]);

    this.root = el('div', { class: 'findbar', role: 'search', hidden: true }, [
      el('div', { class: 'findbar-row' }, [
        this.queryInput,
        this.toggles.caseSensitive,
        this.toggles.wholeWord,
        this.toggles.regex,
        this.countLabel,
        previousButton,
        nextButton,
        closeButton,
      ]),
      this.replacementRow,
    ]);

    container.append(this.root);

    this.queryInput.addEventListener('input', () => handlers.onQuery(this.queryInput.value));
    this.replacementInput.addEventListener('input', () => handlers.onReplacement(this.replacementInput.value));

    this.queryInput.addEventListener('keydown', (event) => this.onKeyDown(event, 'query'));
    this.replacementInput.addEventListener('keydown', (event) => this.onKeyDown(event, 'replacement'));

    for (const [flag, button] of Object.entries(this.toggles)) {
      button.addEventListener('click', () => handlers.onToggle(flag as keyof typeof this.toggles));
    }
    nextButton.addEventListener('click', () => handlers.onNext());
    previousButton.addEventListener('click', () => handlers.onPrevious());
    closeButton.addEventListener('click', () => handlers.onClose());
    replaceButton.addEventListener('click', () => handlers.onReplace());
    replaceAllButton.addEventListener('click', () => handlers.onReplaceAll());
  }

  private onKeyDown(event: KeyboardEvent, field: 'query' | 'replacement'): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      this.handlers.onClose();
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      if (field === 'replacement' && !event.shiftKey) this.handlers.onReplace();
      else if (event.shiftKey) this.handlers.onPrevious();
      else this.handlers.onNext();
      return;
    }
    if (event.altKey) {
      const flag = { c: 'caseSensitive', w: 'wholeWord', r: 'regex' }[event.key.toLowerCase()];
      if (flag) {
        event.preventDefault();
        this.handlers.onToggle(flag as 'caseSensitive' | 'wholeWord' | 'regex');
      }
    }
  }

  render(next: Partial<FindBarState>, options: { focus?: 'query' | 'replacement' } = {}): void {
    const state: FindBarState = { ...this.state, ...next };
    this.state = state;
    this.root.hidden = !state.visible;
    this.replacementRow.hidden = !state.replaceVisible;

    if (this.queryInput.value !== state.query) this.queryInput.value = state.query;
    if (this.replacementInput.value !== state.replacement) this.replacementInput.value = state.replacement;

    for (const [flag, button] of Object.entries(this.toggles)) {
      button.setAttribute('aria-pressed', state[flag as keyof typeof this.toggles] ? 'true' : 'false');
    }

    if (state.error) {
      this.countLabel.textContent = 'Invalid pattern';
      this.countLabel.dataset['error'] = 'true';
      this.countLabel.title = state.error;
    } else {
      this.countLabel.dataset['error'] = 'false';
      this.countLabel.title = '';
      this.countLabel.textContent =
        state.count === 0
          ? 'No results'
          : `${state.activeIndex >= 0 ? state.activeIndex + 1 : 0} of ${state.count}`;
    }

    if (options.focus === 'query') {
      this.queryInput.focus({ preventScroll: true });
      this.queryInput.select();
    } else if (options.focus === 'replacement') {
      this.replacementInput.focus({ preventScroll: true });
      this.replacementInput.select();
    }
  }

  get isOpen(): boolean {
    return !this.root.hidden;
  }

  get query(): string {
    return this.state.query;
  }

  focusQuery(): void {
    this.queryInput.focus({ preventScroll: true });
    this.queryInput.select();
  }
}
