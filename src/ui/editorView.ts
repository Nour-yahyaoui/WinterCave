import {
  flattenTokens,
  tokenizeLines,
  type LanguageDef,
  type Token,
  type TokenType,
} from '../core/language';
import { primarySelection, selectionEnd, selectionStart, type Selection } from '../core/selection';
import { escapeHtml } from './dom';

export interface RenderState {
  text: string;
  lines: readonly string[];
  lineStarts: readonly number[];
  selections: readonly Selection[];
  language: LanguageDef;
  highlight: boolean;
  wrap: boolean;
  lineNumbers: boolean;
  spellcheck: boolean;
  matches?: readonly { from: number; to: number }[] | undefined;
  activeMatch?: number;
}

/** Above this the DOM overlay costs more than it gives; fall back to the textarea. */
const PLAIN_MODE_LINES = 4000;
const PLAIN_MODE_BYTES = 2_000_000;

export function isPlainMode(state: Pick<RenderState, 'lines' | 'text'>): boolean {
  return state.lines.length > PLAIN_MODE_LINES || state.text.length > PLAIN_MODE_BYTES;
}

interface LineMark {
  from: number;
  to: number;
  kind: 'selection' | 'match' | 'match-current';
}

/**
 * The editing surface: a `textarea` for input, accessibility and IME, plus a
 * painted overlay behind it for syntax colours, multi-cursor decorations and
 * search highlights. Native caret handling is kept — no caret reimplementation.
 */
export class EditorView {
  readonly root: HTMLElement;
  readonly textarea: HTMLTextAreaElement;
  readonly surface: HTMLElement;
  private readonly gutter: HTMLElement;
  private readonly gutterInner: HTMLElement;
  private readonly overlay: HTMLElement;
  private readonly overlayInner: HTMLElement;
  private readonly verticalTrack: HTMLElement;
  private readonly verticalThumb: HTMLElement;
  private readonly horizontalTrack: HTMLElement;
  private readonly horizontalThumb: HTMLElement;
  private composing = false;
  private lastRenderedText = '';

  constructor(container: HTMLElement) {
    this.gutterInner = document.createElement('div');
    this.gutterInner.className = 'gutter-inner';
    this.gutter = document.createElement('div');
    this.gutter.className = 'gutter';
    this.gutter.setAttribute('aria-hidden', 'true');
    this.gutter.append(this.gutterInner);

    this.overlayInner = document.createElement('div');
    this.overlayInner.className = 'overlay-inner';
    this.overlay = document.createElement('div');
    this.overlay.className = 'overlay';
    this.overlay.setAttribute('aria-hidden', 'true');
    this.overlay.append(this.overlayInner);

    this.textarea = document.createElement('textarea');
    this.textarea.className = 'input';
    this.textarea.spellcheck = false;
    this.textarea.autocapitalize = 'off';
    this.textarea.autocomplete = 'off';
    this.textarea.setAttribute('autocorrect', 'off');
    this.textarea.setAttribute('wrap', 'off');
    this.textarea.setAttribute('aria-label', 'Document text');
    this.textarea.setAttribute('role', 'textbox');
    this.textarea.setAttribute('aria-multiline', 'true');

    this.surface = document.createElement('div');
    this.surface.className = 'surface';
    this.surface.append(this.overlay, this.textarea);

    this.verticalThumb = document.createElement('div');
    this.verticalThumb.className = 'scrollbar-thumb';
    this.verticalTrack = document.createElement('div');
    this.verticalTrack.className = 'scrollbar';
    this.verticalTrack.dataset['axis'] = 'y';
    this.verticalTrack.append(this.verticalThumb);

    this.horizontalThumb = document.createElement('div');
    this.horizontalThumb.className = 'scrollbar-thumb';
    this.horizontalTrack = document.createElement('div');
    this.horizontalTrack.className = 'scrollbar';
    this.horizontalTrack.dataset['axis'] = 'x';
    this.horizontalTrack.append(this.horizontalThumb);

    this.root = document.createElement('div');
    this.root.className = 'editor';
    this.root.append(this.gutter, this.surface, this.verticalTrack, this.horizontalTrack);
    container.append(this.root);

    this.textarea.addEventListener('scroll', () => this.onScroll(), { passive: true });
    if (typeof ResizeObserver !== 'undefined') {
      new ResizeObserver(() => this.updateScrollbars()).observe(this.surface);
    } else {
      window.addEventListener('resize', () => this.updateScrollbars());
    }
    this.bindScrollbars();
  }

  get isComposing(): boolean {
    return this.composing;
  }

  setComposing(value: boolean): void {
    this.composing = value;
  }

  get selection(): Selection {
    return {
      anchor: this.textarea.selectionStart ?? 0,
      head: this.textarea.selectionEnd ?? 0,
    };
  }

  focus(): void {
    this.textarea.focus({ preventScroll: true });
  }

  render(state: RenderState, options: { syncSelection?: boolean } = {}): void {
    const plain = isPlainMode(state);
    this.root.dataset['plain'] = plain ? 'true' : 'false';
    this.overlay.hidden = plain;
    this.overlay.dataset['wrap'] = state.wrap ? 'true' : 'false';
    this.textarea.dataset['wrap'] = state.wrap ? 'true' : 'false';
    this.textarea.setAttribute('wrap', state.wrap ? 'soft' : 'off');
    if (this.textarea.spellcheck !== state.spellcheck) this.textarea.spellcheck = state.spellcheck;

    if (!this.composing && state.text !== this.lastRenderedText) {
      const { scrollTop, scrollLeft } = this.textarea;
      this.textarea.value = state.text;
      this.textarea.scrollTop = scrollTop;
      this.textarea.scrollLeft = scrollLeft;
      this.lastRenderedText = state.text;
    }

    if (!plain) this.paintOverlay(state);
    this.paintGutter(state);

    if (options.syncSelection && !this.composing) {
      const primary = primarySelection(state.selections);
      this.applySelection(primary);
      this.revealCaret(state);
    }

    this.onScroll();
  }

  /** Force the next render to rewrite the textarea even if the text looks equal. */
  invalidateText(): void {
    this.lastRenderedText = '';
  }

  private applySelection(selection: Selection): void {
    const start = selectionStart(selection);
    const end = selectionEnd(selection);
    if (this.textarea.selectionStart === start && this.textarea.selectionEnd === end) return;
    try {
      this.textarea.setSelectionRange(start, end, start === selection.head ? 'forward' : 'backward');
    } catch {
      this.textarea.setSelectionRange(start, end);
    }
  }

  /** Only scrolls when the caret actually left the viewport — no jitter while typing. */
  private revealCaret(state: RenderState): void {
    if (state.wrap) return;
    const caret = primarySelection(state.selections).head;
    const line = lineForOffset(state.lineStarts, caret);
    const lineHeight = this.lineHeight();
    if (lineHeight <= 0) return;
    const top = line * lineHeight;
    const bottom = top + lineHeight;
    const viewTop = this.textarea.scrollTop;
    const viewBottom = viewTop + this.textarea.clientHeight - 16;
    if (top < viewTop) this.textarea.scrollTop = top;
    else if (bottom > viewBottom) this.textarea.scrollTop = bottom - this.textarea.clientHeight + 16;
  }

  private lineHeight(): number {
    const raw = getComputedStyle(this.root).getPropertyValue('--line-height').trim();
    const parsed = Number.parseFloat(raw);
    return Number.isFinite(parsed) ? parsed : 21;
  }

  private onScroll(): void {
    const { scrollTop, scrollLeft } = this.textarea;
    this.overlayInner.style.transform = `translate(${-scrollLeft}px, ${-scrollTop}px)`;
    this.gutterInner.style.transform = `translateY(${-scrollTop}px)`;
    this.updateScrollbars();
  }

  private paintOverlay(state: RenderState): void {
    const primary = primarySelection(state.selections);
    const extras = state.selections.filter((selection) => selection !== primary);
    const matches = state.highlight ? (state.matches ?? []) : [];

    const tokensByLine = state.highlight
      ? tokenizeLines(state.lines, state.language)
      : new Map<number, { tokens: Token[] }>();

    const parts: string[] = [];
    const lineHeight = this.lineHeight();
    const activeLine = lineForOffset(state.lineStarts, primary.head);
    if (!state.wrap) {
      parts.push(`<div class="active-line" style="top:${activeLine * lineHeight}px"></div>`);
    }

    for (let index = 0; index < state.lines.length; index += 1) {
      const line = state.lines[index] ?? '';
      const lineStart = state.lineStarts[index] ?? 0;
      const tokenized = tokensByLine.get(index);
      const tokens = tokenized ? flattenTokens(line, tokenized.tokens) : [];
      parts.push(this.renderLine(line, lineStart, tokens, extras, matches, state, activeLine === index));
    }

    this.overlayInner.innerHTML = parts.join('');
  }

  private renderLine(
    line: string,
    lineStart: number,
    tokens: readonly Token[],
    selections: readonly Selection[],
    matches: readonly { from: number; to: number }[],
    state: RenderState,
    isActive: boolean,
  ): string {
    const lineLength = line.length;
    const marks: LineMark[] = [];
    const carets: number[] = [];

    for (const selection of selections) {
      const from = selectionStart(selection);
      const to = selectionEnd(selection);
      if (from === to) {
        const position = from - lineStart;
        if (position >= 0 && position <= lineLength) carets.push(position);
        continue;
      }
      if (to <= lineStart || from >= lineStart + lineLength) continue;
      marks.push({
        from: Math.max(0, from - lineStart),
        to: Math.min(lineLength, to - lineStart),
        kind: 'selection',
      });
    }

    for (let index = 0; index < matches.length; index += 1) {
      const match = matches[index];
      if (!match) continue;
      if (match.to <= lineStart || match.from >= lineStart + lineLength) continue;
      marks.push({
        from: Math.max(0, match.from - lineStart),
        to: Math.min(lineLength, match.to - lineStart),
        kind: index === state.activeMatch ? 'match-current' : 'match',
      });
    }

    const boundaries = new Set<number>([0, lineLength]);
    for (const token of tokens) {
      boundaries.add(token.start);
      boundaries.add(token.end);
    }
    for (const mark of marks) {
      boundaries.add(mark.from);
      boundaries.add(mark.to);
    }
    for (const caret of carets) boundaries.add(caret);
    const points = [...boundaries].filter((point) => point >= 0 && point <= lineLength).sort((a, b) => a - b);

    let html = '';
    let caretCursor = 0;
    const sortedCarets = [...carets].sort((a, b) => a - b);

    for (let index = 0; index < points.length; index += 1) {
      const start = points[index] ?? 0;
      while (caretCursor < sortedCarets.length && (sortedCarets[caretCursor] ?? 0) <= start) {
        if ((sortedCarets[caretCursor] ?? 0) === start) html += '<span class="cursor"></span>';
        caretCursor += 1;
      }
      const end = points[index + 1];
      if (end === undefined || end === start) continue;

      const tokenType = tokenAt(tokens, start);
      const classes: string[] = [];
      if (tokenType) classes.push(`tok-${tokenType}`);
      for (const mark of marks) {
        if (start >= mark.from && start < mark.to) {
          classes.push(mark.kind);
          break;
        }
      }
      const text = escapeHtml(line.slice(start, end));
      html += classes.length > 0 ? `<span class="${classes.join(' ')}">${text}</span>` : text;
    }

    // Trailing carets (end of line / empty line) and a stable wrap anchor.
    while (caretCursor < sortedCarets.length) {
      html += '<span class="cursor"></span>';
      caretCursor += 1;
    }

    const activeAttr = isActive ? ' data-active-line="true"' : '';
    return `<div class="line"${activeAttr}>${html}</div>`;
  }

  private paintGutter(state: RenderState): void {
    const hide = !state.lineNumbers || state.wrap;
    this.gutter.hidden = hide;
    if (hide) return;

    const lineHeight = this.lineHeight();
    const first = Math.max(0, Math.floor(this.textarea.scrollTop / lineHeight) - 1);
    const visible = Math.ceil(this.textarea.clientHeight / lineHeight) + 3;
    const last = Math.min(state.lines.length - 1, first + visible);
    const activeLine = lineForOffset(state.lineStarts, primarySelection(state.selections).head);
    const width = String(state.lines.length).length;

    const parts: string[] = [];
    for (let index = first; index <= last; index += 1) {
      const label = String(index + 1).padStart(width, ' ');
      const active = index === activeLine;
      parts.push(
        `<div class="gutter-line" data-active="${active ? 'true' : 'false'}">${label}</div>`,
      );
    }
    this.gutterInner.innerHTML = parts.join('');
    this.gutterInner.style.paddingTop = `${first * lineHeight}px`;
  }

  private updateScrollbars(): void {
    const { scrollTop, scrollHeight, clientHeight, scrollLeft, scrollWidth, clientWidth } = this.textarea;

    const needsVertical = scrollHeight > clientHeight + 1;
    this.verticalTrack.style.display = needsVertical ? '' : 'none';
    if (needsVertical) {
      const trackHeight = this.verticalTrack.clientHeight;
      const thumbHeight = Math.max(24, (clientHeight / scrollHeight) * trackHeight);
      const maxTop = Math.max(0, trackHeight - thumbHeight);
      const ratio = scrollTop / Math.max(1, scrollHeight - clientHeight);
      this.verticalThumb.style.height = `${thumbHeight}px`;
      this.verticalThumb.style.top = `${Math.min(maxTop, ratio * maxTop)}px`;
    }

    const needsHorizontal = scrollWidth > clientWidth + 1;
    this.horizontalTrack.style.display = needsHorizontal ? '' : 'none';
    if (needsHorizontal) {
      const trackWidth = this.horizontalTrack.clientWidth;
      const thumbWidth = Math.max(24, (clientWidth / scrollWidth) * trackWidth);
      const maxLeft = Math.max(0, trackWidth - thumbWidth);
      const ratio = scrollLeft / Math.max(1, scrollWidth - clientWidth);
      this.horizontalThumb.style.width = `${thumbWidth}px`;
      this.horizontalThumb.style.left = `${Math.min(maxLeft, ratio * maxLeft)}px`;
    }
  }

  private bindScrollbars(): void {
    const drag = (track: HTMLElement, thumb: HTMLElement, axis: 'x' | 'y') => {
      thumb.addEventListener('pointerdown', (event) => {
        event.preventDefault();
        const startPointer = axis === 'y' ? event.clientY : event.clientX;
        const startScroll = axis === 'y' ? this.textarea.scrollTop : this.textarea.scrollLeft;
        const thumbSize = axis === 'y' ? thumb.clientHeight : thumb.clientWidth;
        const trackSize = axis === 'y' ? track.clientHeight : track.clientWidth;
        const scrollSize = axis === 'y' ? this.textarea.scrollHeight : this.textarea.scrollWidth;
        const visible = axis === 'y' ? this.textarea.clientHeight : this.textarea.clientWidth;
        const scrollable = Math.max(1, scrollSize - visible);
        const scale = scrollable / Math.max(1, trackSize - thumbSize);
        track.dataset['active'] = 'true';

        const move = (moveEvent: PointerEvent) => {
          const current = axis === 'y' ? moveEvent.clientY : moveEvent.clientX;
          const delta = (current - startPointer) * scale;
          if (axis === 'y') this.textarea.scrollTop = startScroll + delta;
          else this.textarea.scrollLeft = startScroll + delta;
        };
        const up = () => {
          track.dataset['active'] = 'false';
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', up);
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
      });
    };

    drag(this.verticalTrack, this.verticalThumb, 'y');
    drag(this.horizontalTrack, this.horizontalThumb, 'x');
  }
}

export function lineForOffset(lineStarts: readonly number[], offset: number): number {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if ((lineStarts[mid] ?? 0) <= offset) low = mid;
    else high = mid - 1;
  }
  return low;
}

function tokenAt(tokens: readonly Token[], offset: number): TokenType | null {
  for (const token of tokens) {
    if (offset >= token.start && offset < token.end) return token.type;
    if (token.start > offset) break;
  }
  return null;
}
