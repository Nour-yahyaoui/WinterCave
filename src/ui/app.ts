import { CommandRegistry } from '../core/commands';
import { TextDocument } from '../core/document';
import { applyConcurrentEditsWithCarets, createEdits, type TextEdit } from '../core/edits';
import { History, type EditKind } from '../core/history';
import {
  DEFAULT_BINDINGS,
  comboFromEvent,
  formatCombo,
  isMacPlatform,
  normalizeKeymap,
  resolveCommand,
  type Keymap,
} from '../core/keymap';
import { LANGUAGES, getLanguage, languageForFilename } from '../core/language';
import { LIMITS, byteLength, classifySize, formatBytes, shouldHighlight } from '../core/limits';
import { Search, type SearchMatch } from '../core/search';
import {
  caret,
  clampSelection,
  dedupeSelections,
  isCollapsed,
  primarySelection,
  selectionEnd,
  selectionStart,
  type Selection,
} from '../core/selection';
import {
  computeNewline,
  decideAutoClose,
  detectIndent,
  reindentBlock,
  smartHomeTarget,
  toggleCommentBlock,
} from '../core/smartEdit';
import {
  JOURNAL_KEY,
  clearJournal,
  loadSession,
  readJournal,
  saveSession,
  writeJournal,
  type JournalEntry,
  type SerializedDocument,
} from '../core/session';
import { nextGraphemeBoundary, previousGraphemeBoundary } from '../core/text';
import { clear, debounce, el } from './dom';
import { EditorView } from './editorView';
import { FindBar } from './findBar';
import { Palette, type PaletteItem } from './palette';

declare global {
  interface Window {
    showOpenFilePicker?: (options?: {
      multiple?: boolean;
      types?: { description: string; accept: Record<string, string[]> }[];
      excludeAcceptAllOption?: boolean;
    }) => Promise<FileSystemFileHandle[]>;
    showSaveFilePicker?: (options?: {
      suggestedName?: string;
      types?: { description: string; accept: Record<string, string[]> }[];
    }) => Promise<FileSystemFileHandle>;
  }
}

const SETTINGS_KEY = 'wintercave.settings.v1';

interface Settings {
  theme: 'system' | 'light' | 'dark';
  fontSize: number;
  lineNumbers: boolean;
  highlight: boolean;
  wrap: 'auto' | 'on' | 'off';
}

const DEFAULT_SETTINGS: Settings = {
  theme: 'system',
  fontSize: 14,
  lineNumbers: true,
  highlight: true,
  wrap: 'auto',
};

interface OpenDocument {
  id: string;
  name: string;
  path: string | null;
  handle: FileSystemFileHandle | null;
  doc: TextDocument;
  savedText: string;
  selections: Selection[];
  languageId: string;
  readOnly: boolean;
  wrapOverride: boolean | null;
  scrollTop: number;
  history: History;
  indent: { indentUnit: string; insertSpaces: boolean };
  createdAt: number;
  cachedText: string;
  lines: string[];
  lineStarts: number[];
  bytes: number;
}

interface FindState {
  visible: boolean;
  replaceVisible: boolean;
  query: string;
  replacement: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
  index: number;
}

const PICKER_TYPES = [{ description: 'Text and code', accept: { 'text/plain': ['.txt', '.md', '.json', '.js', '.ts', '.css', '.html', '.py', '.sh', '.yml', '.sql', '.log'] } }];

function uid(): string {
  return `doc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

/**
 * Application shell: owns documents, wires the core to the DOM, and keeps the
 * textarea and the rendered view in sync.
 */
export class App {
  private readonly registry = new CommandRegistry();
  private readonly view: EditorView;
  private readonly findBar: FindBar;
  private readonly palette = new Palette();
  private readonly isMac = isMacPlatform();
  private keymap: Keymap = normalizeKeymap(DEFAULT_BINDINGS);
  private settings: Settings = { ...DEFAULT_SETTINGS };
  private documents: OpenDocument[] = [];
  private activeId: string | null = null;
  private find: FindState = {
    visible: false,
    replaceVisible: false,
    query: '',
    replacement: '',
    caseSensitive: false,
    wholeWord: false,
    regex: false,
    index: -1,
  };
  private matches: SearchMatch[] = [];
  private searchError: string | null = null;
  private untitledCounter = 0;

  private readonly tabsEl: HTMLElement;
  private readonly noticeEl: HTMLElement;
  private readonly noticeTextEl: HTMLElement;
  private readonly noticeActionsEl: HTMLElement;
  private readonly statusEl: HTMLElement;
  private readonly toastsEl: HTMLElement;
  private statusRefs: {
    position?: HTMLElement;
    selection?: HTMLElement;
    cursors?: HTMLElement;
    language?: HTMLButtonElement;
    indent?: HTMLElement;
    encoding?: HTMLElement;
    eol?: HTMLButtonElement;
    size?: HTMLElement;
    state?: HTMLElement;
  } = {};

  private readonly persistSession = debounce(() => this.writeSession(), 400);
  private readonly persistJournal = debounce(() => this.writeJournalSnapshot(), 700);

  constructor(private readonly host: HTMLElement) {
    this.restoreSettings();
    this.applyTheme();

    this.tabsEl = el('div', { class: 'tabs', role: 'tablist', 'aria-label': 'Open files' });
    this.noticeTextEl = el('span', { class: 'notice-text' });
    this.noticeActionsEl = el('div', { class: 'notice-actions' });
    this.noticeEl = el('div', { class: 'notice', role: 'status', hidden: true }, [
      this.noticeTextEl,
      this.noticeActionsEl,
    ]);
    this.statusEl = el('footer', { class: 'statusbar', role: 'contentinfo' });
    this.toastsEl = el('div', { class: 'toasts', role: 'log', 'aria-live': 'polite' });

    const editorHost = el('main', { class: 'workspace' }, [this.noticeEl]);
    this.view = new EditorView(editorHost);

    const titlebar = el('header', { class: 'titlebar' }, [
      el('div', { class: 'brand' }, [el('span', { class: 'brand-mark' }), el('span', { text: 'WinterCave' })]),
      this.tabsEl,
      el('div', { class: 'titlebar-actions' }, [
        this.iconButton('New file (' + this.primary('file.new', 'N') + ')', '＋', () => this.run('file.new')),
        this.iconButton('Open file (' + this.primary('file.open', 'O') + ')', '↥', () => this.run('file.open')),
        this.iconButton('Command palette (' + this.primary('palette.commands', 'P') + ')', '⌘', () =>
          this.run('palette.commands'),
        ),
      ]),
    ]);

    this.host.append(
      el('div', { class: 'app' }, [titlebar, editorHost, this.statusEl]),
      this.toastsEl,
    );

    this.findBar = new FindBar(editorHost, {
      onQuery: (query) => this.setFind({ query }),
      onReplacement: (replacement) => this.setFind({ replacement }),
      onToggle: (flag) => this.setFind({ [flag]: !this.find[flag] } as Partial<FindState>),
      onNext: () => this.findNext(1),
      onPrevious: () => this.findNext(-1),
      onReplace: () => this.replaceCurrent(),
      onReplaceAll: () => this.replaceAll(),
      onClose: () => this.closeFind(),
    });

    this.registerCommands();
    this.buildStatusBar();
    this.bindEditorEvents();
    this.bindGlobalEvents();
    this.boot();
  }

  /* ------------------------------------------------------------------ boot */

  private boot(): void {
    const session = loadSession(localStorage);
    if (session && session.documents.length > 0) {
      for (const serialized of session.documents) this.adopt(serialized);
      this.activeId = session.activeId && this.documents.some((doc) => doc.id === session.activeId)
        ? session.activeId
        : (this.documents[0]?.id ?? null);
    }

    if (this.documents.length === 0) this.createDocument({ name: 'untitled-1', text: '', languageId: 'markdown' });

    this.activate(this.activeId, { restoreScroll: true });

    const journal = readJournal(localStorage);
    const recoverable = journal.filter((entry) => entry.text.trim().length > 0);
    if (recoverable.length > 0) this.offerRecovery(recoverable);
  }

  private offerRecovery(entries: JournalEntry[]): void {
    this.showNotice(
      `Recovered ${entries.length} unsaved ${entries.length === 1 ? 'buffer' : 'buffers'} from a previous session.`,
      [
        {
          label: 'Restore',
          primary: true,
          run: () => {
            for (const entry of entries) {
              const existing = this.documents.find((doc) => doc.id === entry.id);
              if (existing) {
                existing.doc = new TextDocument(entry.text, existing.doc.eol);
                existing.selections = entry.selections.map((selection) =>
                  clampSelection(selection, existing.doc.length),
                );
                existing.history.clear();
              } else {
                const doc = this.createDocument({
                  id: entry.id,
                  name: entry.name,
                  text: entry.text,
                  languageId: entry.language,
                });
                doc.selections = entry.selections.map((selection) => clampSelection(selection, doc.doc.length));
              }
            }
            clearJournal(localStorage);
            this.hideNotice();
            this.render({ syncSelection: true });
            this.toast('Unsaved changes restored.');
          },
        },
        {
          label: 'Discard',
          run: () => {
            clearJournal(localStorage);
            this.hideNotice();
          },
        },
      ],
    );
  }

  /* --------------------------------------------------------------- helpers */

  private primary(commandId: string, fallback: string): string {
    const combo = Object.entries(DEFAULT_BINDINGS).find(([, id]) => id === commandId)?.[0];
    return combo ? formatCombo(combo, this.isMac) : fallback;
  }

  private iconButton(title: string, glyph: string, onClick: () => void): HTMLElement {
    const button = el('button', { class: 'icon-button', type: 'button', title, 'aria-label': title, text: glyph });
    button.addEventListener('click', onClick);
    return button;
  }

  /** Commands are the single source of truth for menus, shortcuts and the palette. */
  get commands(): CommandRegistry {
    return this.registry;
  }

  private get active(): OpenDocument | undefined {
    return this.documents.find((doc) => doc.id === this.activeId);
  }

  private documentById(id: string): OpenDocument | undefined {
    return this.documents.find((doc) => doc.id === id);
  }

  private run(commandId: string): void {
    void this.registry.run(commandId);
  }

  private isDirty(doc: OpenDocument): boolean {
    return doc.doc.text !== doc.savedText;
  }

  private languageOf(doc: OpenDocument): ReturnType<typeof getLanguage> {
    return getLanguage(doc.languageId);
  }

  private wrapEnabled(doc: OpenDocument): boolean {
    if (this.settings.wrap === 'on') return true;
    if (this.settings.wrap === 'off') return false;
    if (doc.wrapOverride !== null) return doc.wrapOverride;
    return this.languageOf(doc).wordWrapDefault ?? false;
  }

  private refreshCache(doc: OpenDocument): void {
    if (doc.cachedText === doc.doc.text) return;
    doc.cachedText = doc.doc.text;
    doc.lines = doc.doc.lines;
    doc.lineStarts = [...doc.doc.lineStarts];
    doc.bytes = byteLength(doc.doc.text);
  }

  /* ---------------------------------------------------------------- render */

  private render(options: { syncSelection?: boolean } = {}): void {
    const active = this.active;
    if (!active) return;
    this.refreshCache(active);
    const language = this.languageOf(active);
    const bytes = active.bytes;
    const highlight =
      this.settings.highlight &&
      language.family !== 'plain' &&
      shouldHighlight(bytes, active.lines.length);

    this.view.render(
      {
        text: active.doc.text,
        lines: active.lines,
        lineStarts: active.lineStarts,
        selections: active.selections,
        language,
        highlight,
        wrap: this.wrapEnabled(active),
        lineNumbers: this.settings.lineNumbers,
        spellcheck: language.spellcheckDefault === true,
        matches: this.find.visible ? this.matches : [],
        activeMatch: this.find.visible ? this.find.index : -1,
      },
      options,
    );

    active.scrollTop = this.view.textarea.scrollTop;
    this.renderTabs();
    this.renderStatus();
  }

  private renderTabs(): void {
    clear(this.tabsEl);
    for (const doc of this.documents) {
      const selected = doc.id === this.activeId;
      const dirty = this.isDirty(doc);
      const tab = el(
        'div',
        {
          class: 'tab',
          role: 'tab',
          tabindex: selected ? '0' : '-1',
          'aria-selected': selected ? 'true' : 'false',
          title: doc.path ?? doc.name,
        },
        [
          dirty ? el('span', { class: 'tab-dirty', 'aria-label': 'Unsaved changes' }) : null,
          el('span', { class: 'tab-name', text: doc.name }),
        ],
      );
      const close = el('button', {
        class: 'tab-close',
        type: 'button',
        title: `Close ${doc.name}`,
        'aria-label': `Close ${doc.name}`,
        text: '×',
      });
      close.addEventListener('click', (event) => {
        event.stopPropagation();
        this.closeDocument(doc.id);
      });
      tab.append(close);
      tab.addEventListener('click', () => this.activate(doc.id));
      tab.addEventListener('auxclick', (event) => {
        if (event.button === 1) this.closeDocument(doc.id);
      });
      this.tabsEl.append(tab);
    }
  }

  private buildStatusBar(): void {
    clear(this.statusEl);
    const make = (className = 'status-item'): HTMLButtonElement =>
      el('button', { class: className, type: 'button' });

    this.statusRefs.position = el('span', { class: 'status-item' });
    this.statusRefs.selection = el('span', { class: 'status-item' });
    this.statusRefs.cursors = el('span', { class: 'status-item' });
    const language = make();
    language.addEventListener('click', () => this.pickLanguage());
    this.statusRefs.language = language;
    this.statusRefs.indent = el('span', { class: 'status-item' });
    this.statusRefs.encoding = el('span', { class: 'status-item', text: 'UTF-8' });
    const eol = make();
    eol.title = 'Toggle line endings (LF / CRLF)';
    eol.addEventListener('click', () => this.toggleLineEnding());
    this.statusRefs.eol = eol;
    this.statusRefs.size = el('span', { class: 'status-item' });
    this.statusRefs.state = el('span', { class: 'status-item' });

    const wrapToggle = make();
    wrapToggle.textContent = 'wrap';
    wrapToggle.title = 'Toggle word wrap';
    wrapToggle.addEventListener('click', () => this.run('view.toggleWrap'));

    const themeButton = make();
    themeButton.textContent = 'theme';
    themeButton.title = 'Toggle theme (light / dark)';
    themeButton.addEventListener('click', () => this.run('view.toggleTheme'));

    this.statusEl.append(
      this.statusRefs.position,
      this.statusRefs.selection,
      this.statusRefs.cursors,
      el('span', { class: 'status-spacer' }),
      this.statusRefs.indent,
      this.statusRefs.encoding,
      this.statusRefs.eol,
      this.statusRefs.size,
      wrapToggle,
      themeButton,
      this.statusRefs.language,
      this.statusRefs.state,
    );
  }

  private renderStatus(): void {
    const active = this.active;
    if (!active) return;
    const primary = primarySelection(active.selections);
    const position = active.doc.positionAt(primary.head);
    const selected = active.selections.reduce((total, selection) => total + Math.abs(selection.head - selection.anchor), 0);

    if (this.statusRefs.position) {
      this.statusRefs.position.textContent = `Ln ${position.line + 1}, Col ${position.column + 1}`;
    }
    if (this.statusRefs.selection) {
      this.statusRefs.selection.textContent =
        selected > 0 ? `${selected} selected` : `${active.doc.length} chars`;
    }
    if (this.statusRefs.cursors) {
      this.statusRefs.cursors.textContent = active.selections.length > 1 ? `${active.selections.length} cursors` : '';
    }
    if (this.statusRefs.language) {
      this.statusRefs.language.textContent = this.languageOf(active).name;
      this.statusRefs.language.title = 'Change language mode';
    }
    if (this.statusRefs.indent) {
      this.statusRefs.indent.textContent =
        active.indent.indentUnit === '\t' ? 'Tabs' : `Spaces: ${active.indent.indentUnit.length}`;
    }
    if (this.statusRefs.eol) this.statusRefs.eol.textContent = active.doc.eol === '\r\n' ? 'CRLF' : 'LF';
    if (this.statusRefs.size) this.statusRefs.size.textContent = formatBytes(active.bytes);
    if (this.statusRefs.state) {
      const dirty = this.isDirty(active);
      this.statusRefs.state.innerHTML = '';
      this.statusRefs.state.append(
        el('span', { class: 'status-dot', 'data-dirty': dirty ? 'true' : 'false' }),
        document.createTextNode(dirty ? 'Unsaved' : active.readOnly ? 'Read-only' : 'Saved'),
      );
    }
  }

  private toast(message: string, kind: 'info' | 'error' = 'info', action?: { label: string; run: () => void }): void {
    const body = el('div', { class: 'toast-body', text: message });
    const toast = el('div', { class: 'toast', 'data-kind': kind, role: 'status' }, [body]);
    if (action) {
      const button = el('button', { class: 'toast-action', type: 'button', text: action.label });
      button.addEventListener('click', () => {
        action.run();
        toast.remove();
      });
      toast.append(button);
    }
    this.toastsEl.append(toast);
    const timer = setTimeout(() => toast.remove(), kind === 'error' ? 7000 : 4000);
    toast.addEventListener('click', (event) => {
      if (event.target === toast) {
        clearTimeout(timer);
        toast.remove();
      }
    });
  }

  private showNotice(message: string, actions: { label: string; primary?: boolean; run: () => void }[]): void {
    this.noticeTextEl.textContent = message;
    clear(this.noticeActionsEl);
    for (const action of actions) {
      const button = el('button', {
        class: `button${action.primary ? ' button-primary' : ''}`,
        type: 'button',
        text: action.label,
      });
      button.addEventListener('click', action.run);
      this.noticeActionsEl.append(button);
    }
    this.noticeEl.hidden = false;
  }

  private hideNotice(): void {
    this.noticeEl.hidden = true;
  }

  /* -------------------------------------------------------------- documents */

  private createDocument(input: {
    id?: string;
    name: string;
    path?: string | null;
    handle?: FileSystemFileHandle | null;
    text: string;
    languageId?: string;
    eol?: '\n' | '\r\n';
    readOnly?: boolean;
    savedText?: string;
  }): OpenDocument {
    const doc = new TextDocument(input.text, input.eol);
    const languageId = input.languageId ?? languageForFilename(input.name).id;
    const document_: OpenDocument = {
      id: input.id ?? uid(),
      name: input.name,
      path: input.path ?? null,
      handle: input.handle ?? null,
      doc,
      savedText: input.savedText ?? doc.text,
      selections: [caret(0)],
      languageId,
      readOnly: input.readOnly ?? false,
      wrapOverride: null,
      scrollTop: 0,
      history: new History({ limit: 1000, groupWindowMs: 500 }),
      indent: detectIndent(doc.text),
      createdAt: Date.now(),
      cachedText: '',
      lines: [],
      lineStarts: [],
      bytes: 0,
    };
    this.refreshCache(document_);
    this.documents.push(document_);
    this.activeId = document_.id;
    this.schedulePersist();
    return document_;
  }

  private adopt(serialized: SerializedDocument): OpenDocument {
    const doc = new TextDocument(serialized.text, serialized.lineEnding);
    const entry: OpenDocument = {
      id: serialized.id,
      name: serialized.name,
      path: serialized.path ?? null,
      handle: null,
      doc,
      savedText: serialized.savedText,
      selections:
        serialized.selections.length > 0
          ? serialized.selections.map((selection) => clampSelection(selection, doc.length))
          : [caret(0)],
      languageId: serialized.language,
      readOnly: serialized.readOnly,
      wrapOverride: null,
      scrollTop: serialized.scrollTop,
      history: new History({ limit: 1000, groupWindowMs: 500 }),
      indent: detectIndent(doc.text),
      createdAt: serialized.modifiedAt || Date.now(),
      cachedText: '',
      lines: [],
      lineStarts: [],
      bytes: 0,
    };
    this.refreshCache(entry);
    this.documents.push(entry);
    return entry;
  }

  private activate(id: string | null, options: { restoreScroll?: boolean } = {}): void {
    const doc = id ? this.documentById(id) : this.active;
    if (!doc) return;
    // Capture the target before render() writes the live scroll position back.
    const targetScroll = options.restoreScroll ? doc.scrollTop : this.view.textarea.scrollTop;
    this.activeId = doc.id;
    this.render({ syncSelection: true });
    this.view.textarea.scrollTop = targetScroll;
    doc.scrollTop = targetScroll;
    this.view.focus();
    this.schedulePersist();
  }

  private closeDocument(id: string): void {
    const doc = this.documentById(id);
    if (!doc) return;
    if (this.isDirty(doc)) {
      const proceed = window.confirm(`"${doc.name}" has unsaved changes. Close it anyway?`);
      if (!proceed) return;
    }
    const index = this.documents.findIndex((entry) => entry.id === id);
    this.documents = this.documents.filter((entry) => entry.id !== id);
    if (this.documents.length === 0) {
      this.untitledCounter += 1;
      this.createDocument({ name: `untitled-${this.untitledCounter}`, text: '', languageId: 'markdown' });
    } else if (this.activeId === id) {
      const next = this.documents[Math.min(index, this.documents.length - 1)];
      this.activeId = next?.id ?? this.documents[0]?.id ?? null;
    }
    this.render({ syncSelection: true });
    this.schedulePersist();
    this.persistJournal();
  }

  /* ------------------------------------------------------------- editing ops */

  private commit(
    edits: TextEdit[],
    kind: EditKind,
    options: { selections?: Selection[]; mapCarets?: (carets: number[]) => Selection[] } = {},
  ): void {
    const active = this.active;
    if (!active || active.readOnly) return;
    if (edits.length === 0) return;

    const applied = createEdits(active.doc, edits);
    const result = applyConcurrentEditsWithCarets(active.doc, edits);
    const selections = (
      options.selections ??
      options.mapCarets?.(result.carets) ??
      result.carets.map((offset) => caret(offset))
    ).map((selection) => clampSelection(selection, result.doc.length));

    const meaningful = applied.some((edit) => edit.removed !== edit.text);
    if (!meaningful) return;

    active.history.push({
      edits: applied,
      kind,
      selBefore: active.selections,
      selAfter: selections,
      at: Date.now(),
    });
    active.doc = result.doc;
    active.selections = dedupeSelections(selections);
    active.indent = detectIndent(active.doc.text);
    this.afterEdit();
  }

  private afterEdit(): void {
    const active = this.active;
    if (!active) return;
    this.refreshCache(active);
    this.updateFindMatches();
    this.render({ syncSelection: true });
    this.schedulePersist();
    this.persistJournal();
  }

  private insertText(raw: string, kind: EditKind = 'insert'): void {
    const active = this.active;
    if (!active || active.readOnly) return;
    const text = raw.replace(/\r\n?/g, '\n');
    if (text.length === 0) return;

    if (text.length === 1 && active.selections.length === 1 && !this.view.isComposing) {
      const primary = primarySelection(active.selections);
      const from = selectionStart(primary);
      const to = selectionEnd(primary);
      const action = decideAutoClose({
        char: text,
        before: active.doc.text[from - 1] ?? '',
        after: active.doc.text[to] ?? '',
        hasSelection: from !== to,
      });

      if (action?.type === 'skip') {
        active.selections = [caret(to + action.advance)];
        this.render({ syncSelection: true });
        return;
      }
      if (action?.type === 'insert') {
        this.commit([{ from, to, text: action.text }], 'insert', {
          mapCarets: (carets) => carets.map((offset) => caret(offset - (action.text.length - 1))),
        });
        return;
      }
      if (action?.type === 'wrap') {
        const inner = active.doc.text.slice(from, to);
        this.commit([{ from, to, text: action.open + inner + action.close }], 'insert', {
          selections: [{ anchor: from + 1, head: from + 1 + inner.length }],
        });
        return;
      }
    }

    const edits = active.selections.map((selection) => ({
      from: selectionStart(selection),
      to: selectionEnd(selection),
      text,
    }));
    this.commit(edits, kind);
  }

  private insertNewline(): void {
    const active = this.active;
    if (!active || active.readOnly) return;
    const edits: TextEdit[] = [];
    const offsets: number[] = [];
    for (const selection of active.selections) {
      const from = selectionStart(selection);
      const to = selectionEnd(selection);
      const line = active.doc.lineAt(from);
      const range = active.doc.lineRange(line);
      const result = computeNewline({
        lineText: active.doc.text.slice(range.start, range.end),
        column: from - range.start,
        indentUnit: active.indent.indentUnit,
      });
      edits.push({ from, to, text: result.text });
      offsets.push(result.caret);
    }
    this.commit(edits, 'insert', {
      mapCarets: (carets) =>
        carets.map((offset, index) => caret(offset - (edits[index]!.text.length - (offsets[index] ?? 0)))),
    });
  }

  private deleteBackward(): void {
    const active = this.active;
    if (!active || active.readOnly) return;
    const edits: TextEdit[] = active.selections.map((selection) => {
      if (!isCollapsed(selection)) return { from: selectionStart(selection), to: selectionEnd(selection), text: '' };
      const from = previousGraphemeBoundary(active.doc.text, selection.head);
      return { from, to: selection.head, text: '' };
    });
    this.commit(edits, 'delete');
  }

  private deleteForward(): void {
    const active = this.active;
    if (!active || active.readOnly) return;
    const edits: TextEdit[] = active.selections.map((selection) => {
      if (!isCollapsed(selection)) return { from: selectionStart(selection), to: selectionEnd(selection), text: '' };
      const to = nextGraphemeBoundary(active.doc.text, selection.head);
      return { from: selection.head, to, text: '' };
    });
    this.commit(edits, 'delete');
  }

  private indentSelection(direction: 'indent' | 'outdent'): void {
    const active = this.active;
    if (!active || active.readOnly) return;
    const primary = primarySelection(active.selections);
    const from = selectionStart(primary);
    const to = selectionEnd(primary);
    if (isCollapsed(primary)) {
      if (direction === 'indent') this.insertText(this.indentString(active, from), 'indent');
      else this.outdentLineAt(from);
      return;
    }
    const firstLine = active.doc.lineAt(from);
    const lastLine = active.doc.lineAt(to);
    const blockStart = active.doc.lineRange(firstLine).start;
    const blockEnd = active.doc.lineRange(lastLine).end;
    const lines = active.doc.text.slice(blockStart, blockEnd).split('\n');
    const reindented = reindentBlock(lines, active.indent, direction).join('\n');
    this.commit([{ from: blockStart, to: blockEnd, text: reindented }], 'indent', {
      selections: [{ anchor: blockStart, head: blockStart + reindented.length }],
    });
  }

  /** Spaces to the next tab stop (or a tab) for a single Tab press. */
  private indentString(active: OpenDocument, offset: number): string {
    if (!active.indent.insertSpaces) return '\t';
    const range = active.doc.lineRange(active.doc.lineAt(offset));
    const column = offset - range.start;
    const size = active.indent.indentUnit.length || 2;
    const remainder = column % size;
    return ' '.repeat(remainder === 0 ? size : size - remainder);
  }

  private outdentLineAt(offset: number): void {
    const active = this.active;
    if (!active || active.readOnly) return;
    const range = active.doc.lineRange(active.doc.lineAt(offset));
    const line = active.doc.text.slice(range.start, range.end);
    const leading = /^[ \t]*/.exec(line)?.[0] ?? '';
    if (leading.length === 0) return;
    const unit = active.indent.indentUnit;
    const remove = leading.startsWith('\t') ? 1 : Math.min(unit.length || 2, leading.length);
    const caretOffset = Math.max(range.start, offset - remove);
    this.commit([{ from: range.start, to: range.start + remove, text: '' }], 'indent', {
      selections: [{ anchor: caretOffset, head: caretOffset }],
    });
  }

  private moveLines(direction: -1 | 1): void {
    const active = this.active;
    if (!active || active.readOnly) return;
    const primary = primarySelection(active.selections);
    const firstLine = active.doc.lineAt(selectionStart(primary));
    const lastLine = active.doc.lineAt(selectionEnd(primary));
    if (direction === -1 && firstLine === 0) return;
    if (direction === 1 && lastLine >= active.doc.lineCount - 1) return;

    const blockStart = active.doc.lineRange(firstLine).start;
    const blockEnd = active.doc.lineRange(lastLine).end;
    const block = active.doc.text.slice(blockStart, blockEnd);

    if (direction === 1) {
      const nextLine = active.doc.lineRange(lastLine + 1);
      const nextText = active.doc.text.slice(nextLine.start, nextLine.end);
      this.commit([{ from: blockStart, to: nextLine.end, text: `${nextText}\n${block}` }], 'structure', {
        selections: active.selections.map((selection) => ({
          anchor: selection.anchor + nextText.length + 1,
          head: selection.head + nextText.length + 1,
        })),
      });
      return;
    }

    const previousLine = active.doc.lineRange(firstLine - 1);
    const previousText = active.doc.text.slice(previousLine.start, previousLine.end);
    this.commit([{ from: previousLine.start, to: blockEnd, text: `${block}\n${previousText}` }], 'structure', {
      selections: active.selections.map((selection) => ({
        anchor: selection.anchor - previousText.length - 1,
        head: selection.head - previousText.length - 1,
      })),
    });
  }

  private duplicateLines(): void {
    const active = this.active;
    if (!active || active.readOnly) return;
    const primary = primarySelection(active.selections);
    const firstLine = active.doc.lineAt(selectionStart(primary));
    const lastLine = active.doc.lineAt(selectionEnd(primary));
    const blockStart = active.doc.lineRange(firstLine).start;
    const blockEnd = active.doc.lineRange(lastLine).end;
    const block = active.doc.text.slice(blockStart, blockEnd);
    this.commit([{ from: blockEnd, to: blockEnd, text: `\n${block}` }], 'structure', {
      selections: active.selections.map((selection) => ({
        anchor: selection.anchor + block.length + 1,
        head: selection.head + block.length + 1,
      })),
    });
  }

  private deleteLines(): void {
    const active = this.active;
    if (!active || active.readOnly) return;
    const primary = primarySelection(active.selections);
    const firstLine = active.doc.lineAt(selectionStart(primary));
    const lastLine = active.doc.lineAt(selectionEnd(primary));
    const blockStart = active.doc.lineRange(firstLine).start;
    const blockEnd = active.doc.lineRange(lastLine).end;
    const hasNextLine = lastLine < active.doc.lineCount - 1;
    const from = hasNextLine ? blockStart : Math.max(0, blockStart - 1);
    const to = hasNextLine ? active.doc.lineRange(lastLine + 1).start : blockEnd;
    this.commit([{ from, to, text: '' }], 'structure', {
      selections: [caret(from)],
    });
  }

  private toggleComment(): void {
    const active = this.active;
    if (!active || active.readOnly) return;
    const prefix = this.languageOf(active).lineComment;
    if (!prefix) {
      this.toast(`${this.languageOf(active).name} has no line comment syntax.`, 'error');
      return;
    }
    const primary = primarySelection(active.selections);
    const firstLine = active.doc.lineAt(selectionStart(primary));
    const lastLine = active.doc.lineAt(selectionEnd(primary));
    const blockStart = active.doc.lineRange(firstLine).start;
    const blockEnd = active.doc.lineRange(lastLine).end;
    const lines = active.doc.text.slice(blockStart, blockEnd).split('\n');
    const toggled = toggleCommentBlock(lines, prefix).join('\n');
    this.commit([{ from: blockStart, to: blockEnd, text: toggled }], 'indent');
  }

  private undo(): void {
    const active = this.active;
    if (!active || active.readOnly) return;
    const result = active.history.undo(active.doc);
    if (!result) {
      this.toast('Nothing to undo.');
      return;
    }
    active.doc = result.doc;
    active.selections = dedupeSelections(result.selections);
    this.afterEdit();
  }

  private redo(): void {
    const active = this.active;
    if (!active || active.readOnly) return;
    const result = active.history.redo(active.doc);
    if (!result) {
      this.toast('Nothing to redo.');
      return;
    }
    active.doc = result.doc;
    active.selections = dedupeSelections(result.selections);
    this.afterEdit();
  }

  private selectAll(): void {
    const active = this.active;
    if (!active) return;
    active.selections = [{ anchor: 0, head: active.doc.length }];
    this.render({ syncSelection: true });
  }

  private addCursor(direction: 'up' | 'down'): void {
    const active = this.active;
    if (!active) return;
    const primary = primarySelection(active.selections);
    const line = active.doc.lineAt(primary.head);
    const range = active.doc.lineRange(line);
    const column = primary.head - range.start;
    const target = line + (direction === 'down' ? 1 : -1);
    if (target < 0 || target >= active.doc.lineCount) return;
    const offset = clampSelection(
      { anchor: active.doc.offsetAt({ line: target, column }), head: active.doc.offsetAt({ line: target, column }) },
      active.doc.length,
    );
    active.selections = dedupeSelections([...active.selections, offset]);
    this.render({ syncSelection: true });
  }

  private addNextOccurrence(): void {
    const active = this.active;
    if (!active) return;
    const primary = primarySelection(active.selections);

    if (isCollapsed(primary)) {
      const word = wordAt(active.doc.text, primary.head);
      if (!word) return;
      active.selections = [{ anchor: word.from, head: word.to }];
      this.render({ syncSelection: true });
      return;
    }

    const needle = active.doc.text.slice(selectionStart(primary), selectionEnd(primary));
    if (needle.length === 0) return;
    const from = active.selections.reduce((max, selection) => Math.max(max, selectionEnd(selection)), 0);
    let index = active.doc.text.indexOf(needle, from);
    if (index === -1) index = active.doc.text.indexOf(needle, 0);
    if (index === -1) return;
    const already = active.selections.some(
      (selection) => selectionStart(selection) === index && selectionEnd(selection) === index + needle.length,
    );
    if (already) {
      this.toast('No more occurrences.');
      return;
    }
    active.selections = dedupeSelections([...active.selections, { anchor: index, head: index + needle.length }]);
    this.render({ syncSelection: true });
  }

  private escapeSelection(): void {
    const active = this.active;
    if (!active) return;
    if (active.selections.length > 1) {
      active.selections = [primarySelection(active.selections)];
      this.render({ syncSelection: true });
      return;
    }
    if (!isCollapsed(primarySelection(active.selections))) {
      const selection = primarySelection(active.selections);
      active.selections = [caret(selectionEnd(selection))];
      this.render({ syncSelection: true });
    }
  }

  private smartHome(toEnd: boolean, extend: boolean): void {
    const active = this.active;
    if (!active) return;
    const primary = primarySelection(active.selections);
    const head = primary.head;
    const line = active.doc.lineAt(head);
    const range = active.doc.lineRange(line);
    const lineText = active.doc.text.slice(range.start, range.end);
    const column = head - range.start;
    const target = toEnd ? range.end : smartHomeTarget(lineText, column);
    const anchor = extend ? primary.anchor : target;
    active.selections = [{ anchor, head: target }];
    this.render({ syncSelection: true });
  }

  /* ------------------------------------------------------------ find/replace */

  private updateFindMatches(): void {
    const active = this.active;
    if (!active || !this.find.visible || this.find.query.length === 0) {
      this.matches = [];
      this.searchError = null;
      return;
    }
    const search = new Search({ ...this.find });
    this.searchError = search.error;
    this.matches = search.error ? [] : search.matches(active.doc.text);
    if (this.find.index >= this.matches.length) this.find.index = this.matches.length - 1;
  }

  private openFind(replace: boolean): void {
    const active = this.active;
    if (!active) return;
    const primary = primarySelection(active.selections);
    if (!isCollapsed(primary)) {
      const selected = active.doc.text.slice(selectionStart(primary), selectionEnd(primary));
      if (!selected.includes('\n') && selected.length <= 200) this.find.query = selected;
    }
    this.find.visible = true;
    this.find.replaceVisible = replace;
    this.updateFindMatches();
    if (this.matches.length > 0) this.jumpToMatch(0);
    this.renderFind({ focus: 'query' });
  }

  private closeFind(): void {
    this.find.visible = false;
    this.find.index = -1;
    this.renderFind();
    this.render({ syncSelection: false });
    this.view.focus();
  }

  private setFind(patch: Partial<FindState>): void {
    this.find = { ...this.find, ...patch, index: patch.index ?? -1 };
    this.updateFindMatches();
    if (this.matches.length > 0 && patch.index === undefined) this.jumpToMatch(0);
    this.renderFind();
    this.render({ syncSelection: true });
  }

  private jumpToMatch(index: number): void {
    const match = this.matches[index];
    if (!match) return;
    const active = this.active;
    if (!active) return;
    this.find.index = index;
    active.selections = [{ anchor: match.from, head: match.to }];
    this.render({ syncSelection: true });
  }

  private findNext(direction: 1 | -1): void {
    if (this.matches.length === 0) {
      this.updateFindMatches();
      if (this.matches.length === 0) return;
    }
    const active = this.active;
    if (!active) return;
    const primary = primarySelection(active.selections);
    const search = new Search({ ...this.find });
    const index = search.nextIndex(this.matches, direction === 1 ? selectionEnd(primary) : selectionStart(primary), direction === 1 ? 'forward' : 'backward');
    if (index >= 0 && index !== this.find.index) this.jumpToMatch(index);
    else this.jumpToMatch(direction === 1 ? (this.find.index + 1) % this.matches.length : (this.find.index - 1 + this.matches.length) % this.matches.length);
    this.renderFind();
  }

  private replaceCurrent(): void {
    const active = this.active;
    if (!active || active.readOnly) return;
    const match = this.matches[this.find.index];
    if (!match) {
      this.findNext(1);
      return;
    }
    const replacement = this.find.regex
      ? new Search({ ...this.find }).replaceAll(active.doc.text.slice(match.from, match.to), this.find.replacement).text
      : this.find.replacement;
    this.commit([{ from: match.from, to: match.to, text: replacement }], 'replace', {
      selections: [caret(match.from + replacement.length)],
    });
    this.findNext(1);
  }

  private replaceAll(): void {
    const active = this.active;
    if (!active || active.readOnly) return;
    if (this.find.query.length === 0) return;
    const search = new Search({ ...this.find });
    if (search.error) {
      this.toast('Fix the pattern before replacing.', 'error');
      return;
    }
    const result = search.replaceAll(active.doc.text, this.find.replacement);
    if (result.count === 0) {
      this.toast('No matches to replace.');
      return;
    }
    const next = active.doc.withText(result.text);
    const edits = createEdits(active.doc, [{ from: 0, to: active.doc.length, text: result.text }]);
    active.history.push({
      edits,
      kind: 'replace',
      selBefore: active.selections,
      selAfter: [caret(Math.min(primarySelection(active.selections).head, next.length))],
      at: Date.now(),
    });
    active.doc = next;
    active.selections = [caret(0)];
    this.afterEdit();
    this.toast(`Replaced ${result.count} ${result.count === 1 ? 'match' : 'matches'}.`);
  }

  private renderFind(options: { focus?: 'query' | 'replacement' } = {}): void {
    this.findBar.render(
      {
        visible: this.find.visible,
        replaceVisible: this.find.replaceVisible,
        query: this.find.query,
        replacement: this.find.replacement,
        caseSensitive: this.find.caseSensitive,
        wholeWord: this.find.wholeWord,
        regex: this.find.regex,
        count: this.matches.length,
        activeIndex: this.find.index,
        error: this.searchError,
      },
      options,
    );
  }

  /* ---------------------------------------------------------------- palette */

  private quickOpen(): void {
    const items: PaletteItem[] = this.documents.map((doc) => ({
      id: doc.id,
      label: doc.name,
      category: this.isDirty(doc) ? 'unsaved' : doc.path ? 'open' : 'open',
      description: doc.path ?? undefined,
    }));
    this.palette.open({
      label: 'Open file',
      placeholder: 'Type a file name…',
      filter: (query) =>
        query.trim() === ''
          ? items
          : items.filter((item) => item.label.toLowerCase().includes(query.trim().toLowerCase())),
      onSelect: (item) => this.activate(item.id, { restoreScroll: true }),
    });
  }

  private commandPalette(): void {
    this.palette.open({
      label: 'Command palette',
      placeholder: 'Type a command…',
      filter: (query) =>
        this.registry.search(query).map((entry) => ({
          id: entry.item.id,
          label: entry.item.title,
          category: entry.item.category,
          keys: entry.item.keys?.[0] ? formatCombo(entry.item.keys[0], this.isMac) : undefined,
          positions: entry.positions,
        })),
      onSelect: (item) => this.run(item.id),
    });
  }

  private gotoLine(): void {
    this.palette.open({
      label: 'Go to line',
      placeholder: 'line or line:column',
      onSubmit: (value) => {
        const active = this.active;
        if (!active) return;
        const [lineRaw, columnRaw] = value.split(':');
        const line = Number.parseInt(lineRaw ?? '', 10);
        if (!Number.isFinite(line) || line < 1) return;
        const column = Number.parseInt(columnRaw ?? '1', 10);
        const offset = active.doc.offsetAt({
          line: Math.min(line - 1, active.doc.lineCount - 1),
          column: Math.max(0, (Number.isFinite(column) ? column : 1) - 1),
        });
        active.selections = [caret(offset)];
        this.render({ syncSelection: true });
        this.view.focus();
      },
    });
  }

  private pickLanguage(): void {
    const active = this.active;
    if (!active) return;
    this.palette.open({
      label: 'Language mode',
      placeholder: 'Change language…',
      filter: (query) =>
        LANGUAGES.filter((language) => language.name.toLowerCase().includes(query.trim().toLowerCase())).map(
          (language) => ({ id: language.id, label: language.name, category: language.extensions.slice(0, 2).join(' ') }),
        ),
      onSelect: (item) => {
        const doc = this.active;
        if (!doc) return;
        doc.languageId = item.id;
        this.render({ syncSelection: false });
        this.schedulePersist();
        this.toast(`Language: ${item.label}`);
      },
    });
  }

  /* ----------------------------------------------------------------- keymap */

  private onKeyDown(event: KeyboardEvent): void {
    if (this.palette.isOpen) return;
    const active = this.active;
    if (!active) return;

    if (event.key === 'Escape') {
      if (this.find.visible) {
        event.preventDefault();
        this.closeFind();
      } else {
        this.escapeSelection();
      }
      return;
    }

    if ((event.key === 'Home' || event.key === 'End') && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      this.smartHome(event.key === 'End', event.shiftKey);
      return;
    }

    const combo = comboFromEvent(event, this.isMac);
    const command = resolveCommand(this.keymap, combo);
    if (command) {
      event.preventDefault();
      this.run(command);
      return;
    }

    switch (event.key) {
      case 'Tab':
        if (event.ctrlKey || event.metaKey || event.altKey) return;
        event.preventDefault();
        this.indentSelection(event.shiftKey ? 'outdent' : 'indent');
        break;
      case 'Enter':
        if (event.isComposing || this.view.isComposing) return;
        if (event.ctrlKey || event.metaKey || event.altKey) return;
        event.preventDefault();
        this.insertNewline();
        break;
      case 'Backspace':
        // Ctrl/Alt+Backspace is a word delete — let the browser do it correctly.
        if (event.ctrlKey || event.metaKey || event.altKey) return;
        event.preventDefault();
        this.deleteBackward();
        break;
      case 'Delete':
        if (event.ctrlKey || event.metaKey || event.altKey) return;
        event.preventDefault();
        this.deleteForward();
        break;
      default:
        break;
    }
  }

  private onBeforeInput(event: InputEvent): void {
    if (event.isComposing || this.view.isComposing) return;
    switch (event.inputType) {
      case 'insertText':
        if (event.data !== null && event.data.length > 0) {
          event.preventDefault();
          this.insertText(event.data);
        }
        break;
      case 'insertLineBreak':
      case 'insertParagraph':
        event.preventDefault();
        this.insertNewline();
        break;
      case 'insertFromPaste':
        // Handled by the paste listener so undo grouping stays per-paste.
        if (event.data) {
          event.preventDefault();
          this.insertText(event.data, 'paste');
        }
        break;
      case 'deleteContentBackward':
      case 'deleteContentForward':
        event.preventDefault();
        if (event.inputType === 'deleteContentBackward') this.deleteBackward();
        else this.deleteForward();
        break;
      default:
        break;
    }
  }

  /** Reconcile the model with whatever the browser did to the textarea (IME, cut, menu actions). */
  private syncFromTextarea(): void {
    const active = this.active;
    if (!active) return;
    const value = this.view.textarea.value;
    const previous = active.doc.text;
    if (value === previous) {
      active.selections = [clampSelection(this.view.selection, active.doc.length)];
      this.render({ syncSelection: false });
      return;
    }

    let prefix = 0;
    while (prefix < previous.length && prefix < value.length && previous[prefix] === value[prefix]) prefix += 1;
    let suffix = 0;
    while (
      suffix < previous.length - prefix &&
      suffix < value.length - prefix &&
      previous[previous.length - 1 - suffix] === value[value.length - 1 - suffix]
    ) {
      suffix += 1;
    }
    const from = prefix;
    const to = previous.length - suffix;
    const inserted = value.slice(prefix, value.length - suffix);
    const applied = createEdits(active.doc, [{ from, to, text: inserted }]);
    active.doc = active.doc.replaceRange(from, to, inserted);
    active.selections = [clampSelection(this.view.selection, active.doc.length)];
    if (applied.some((edit) => edit.removed !== edit.text)) {
      active.history.push({
        edits: applied,
        kind: 'replace',
        selBefore: [caret(from)],
        selAfter: active.selections,
        at: Date.now(),
      });
    }
    this.afterEdit();
  }

  private bindEditorEvents(): void {
    const textarea = this.view.textarea;
    textarea.addEventListener('keydown', (event) => this.onKeyDown(event));
    textarea.addEventListener('beforeinput', (event) => this.onBeforeInput(event as InputEvent));
    textarea.addEventListener('compositionstart', () => this.view.setComposing(true));
    textarea.addEventListener('compositionend', () => {
      this.view.setComposing(false);
      this.syncFromTextarea();
    });
    textarea.addEventListener('input', () => {
      if (this.view.isComposing) return;
      this.syncFromTextarea();
    });
    textarea.addEventListener('select', () => {
      if (this.view.isComposing) return;
      const active = this.active;
      if (!active) return;
      if (active.selections.length > 1) return;
      active.selections = [this.view.selection];
      this.renderStatus();
    });
    textarea.addEventListener('mouseup', () => {
      const active = this.active;
      if (!active) return;
      if (active.selections.length > 1) return;
      active.selections = [this.view.selection];
      this.renderStatus();
    });
    textarea.addEventListener('paste', (event) => {
      const text = event.clipboardData?.getData('text/plain') ?? '';
      if (text.length === 0) return;
      event.preventDefault();
      if (byteLength(text) > LIMITS.warnBytes) {
        this.toast('That paste is too large for a single undo step.', 'error');
        return;
      }
      this.insertText(text, 'paste');
    });
    textarea.addEventListener('scroll', () => {
      const active = this.active;
      if (active) active.scrollTop = textarea.scrollTop;
    });
  }

  private bindGlobalEvents(): void {
    window.addEventListener('beforeunload', (event) => {
      this.persistSession.flush();
      this.persistJournal.flush();
      if (this.documents.some((doc) => this.isDirty(doc))) {
        event.preventDefault();
        event.returnValue = '';
      }
    });
    window.addEventListener('keydown', (event) => this.onGlobalKeyDown(event));
    window.addEventListener('focus', () => this.schedulePersist());
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        this.persistSession.flush();
        this.persistJournal.flush();
      }
    });
    window.addEventListener('dragover', (event) => {
      if (event.dataTransfer?.types.includes('Files')) event.preventDefault();
    });
    window.addEventListener('drop', (event) => {
      const files = [...(event.dataTransfer?.files ?? [])];
      if (files.length === 0) return;
      event.preventDefault();
      void this.openDroppedFiles(files);
    });
    window.matchMedia?.('(prefers-color-scheme: light)').addEventListener?.('change', () => {
      if (this.settings.theme === 'system') this.applyTheme();
    });
  }

  private onGlobalKeyDown(event: KeyboardEvent): void {
    // The editor handler has already claimed this event if it was handled there.
    if (event.defaultPrevented || this.palette.isOpen) return;
    const command = resolveCommand(this.keymap, comboFromEvent(event, this.isMac));
    if (!command) return;
    event.preventDefault();
    this.run(command);
  }

  /* --------------------------------------------------------------- file I/O */

  private async newFile(): Promise<void> {
    this.untitledCounter += 1;
    this.createDocument({ name: `untitled-${this.untitledCounter}`, text: '', languageId: 'markdown' });
    this.render({ syncSelection: true });
    this.view.focus();
  }

  private async openFile(): Promise<void> {
    if (window.showOpenFilePicker) {
      try {
        const handles = await window.showOpenFilePicker({ multiple: true, types: PICKER_TYPES });
        for (const handle of handles) {
          const file = await handle.getFile();
          await this.openFileObject(file, handle);
        }
        return;
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        this.toast('Could not open the file picker; falling back to a file input.', 'error');
      }
    }
    const input = el('input', { type: 'file', multiple: true, accept: '.txt,.md,.json,.js,.ts,.css,.html,.py,.sh,.yml,.yaml,.sql,.log,*/*' });
    input.addEventListener('change', () => {
      const files = [...(input.files ?? [])];
      void this.openDroppedFiles(files);
    });
    input.click();
  }

  private async openDroppedFiles(files: File[]): Promise<void> {
    for (const file of files) await this.openFileObject(file, null);
  }

  private async openFileObject(file: File, handle: FileSystemFileHandle | null): Promise<void> {
    if (file.size >= LIMITS.refuseBytes) {
      this.toast(`${file.name} is ${formatBytes(file.size)} — too large to open safely.`, 'error');
      return;
    }
    const text = await file.text();
    const existing = this.documents.find((doc) => doc.name === file.name && doc.handle === handle);
    if (existing && this.isDirty(existing)) {
      this.toast(`${file.name} is already open with unsaved changes.`, 'error');
      return;
    }
    if (existing) {
      existing.doc = new TextDocument(text, existing.doc.eol);
      existing.savedText = existing.doc.text;
      existing.selections = [caret(0)];
      existing.history.clear();
      existing.cachedText = '';
      this.activeId = existing.id;
      this.refreshCache(existing);
      this.render({ syncSelection: true });
      this.schedulePersist();
      return;
    }

    const language = languageForFilename(file.name);
    this.createDocument({
      name: file.name,
      path: handle?.name ?? file.name,
      handle,
      text,
      languageId: language.id,
      eol: undefined,
    });
    const sizeClass = classifySize(file.size);
    if (sizeClass === 'warn') {
      this.toast(`${file.name} is ${formatBytes(file.size)} — highlighting is limited for large files.`);
    }
    this.render({ syncSelection: true });
    this.view.focus();
  }

  private async save(): Promise<void> {
    const active = this.active;
    if (!active) return;
    if (active.readOnly) {
      this.toast('This document is read-only.', 'error');
      return;
    }
    if (!active.handle) {
      await this.saveAs();
      return;
    }
    const text = active.doc.getText();
    try {
      const writable = await active.handle.createWritable();
      await writable.write(text);
      await writable.close();
      this.markSaved(active);
    } catch (error) {
      this.toast(`Save failed: ${error instanceof Error ? error.message : 'unknown error'}`, 'error');
    }
  }

  private async saveAs(): Promise<void> {
    const active = this.active;
    if (!active || active.readOnly) return;
    const text = active.doc.getText();
    if (window.showSaveFilePicker) {
      try {
        const handle = await window.showSaveFilePicker({ suggestedName: active.name, types: PICKER_TYPES });
        const writable = await handle.createWritable();
        await writable.write(text);
        await writable.close();
        active.handle = handle;
        active.name = handle.name;
        active.path = handle.name;
        active.languageId = languageForFilename(handle.name).id;
        this.markSaved(active);
        this.renderTabs();
        return;
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        this.toast('Could not save with the file picker; downloading a copy instead.', 'error');
      }
    }
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
    const anchor = el('a', { href: url, download: active.name });
    anchor.click();
    URL.revokeObjectURL(url);
    this.markSaved(active);
  }

  private markSaved(active: OpenDocument): void {
    active.savedText = active.doc.text;
    active.readOnly = false;
    this.persistJournal();
    this.schedulePersist();
    this.render({ syncSelection: false });
    this.toast(`Saved ${active.name}`);
  }

  private toggleLineEnding(): void {
    const active = this.active;
    if (!active) return;
    const next = active.doc.eol === '\r\n' ? '\n' : '\r\n';
    active.doc = new TextDocument(active.doc.text, next);
    this.render({ syncSelection: false });
    this.schedulePersist();
    this.toast(`Line endings: ${next === '\r\n' ? 'CRLF' : 'LF'}`);
  }

  /* ------------------------------------------------------- persistence */

  private schedulePersist(): void {
    this.persistSession();
  }

  private writeSession(): void {
    const documents: SerializedDocument[] = this.documents.map((doc) => ({
      id: doc.id,
      name: doc.name,
      path: doc.path ?? undefined,
      language: doc.languageId,
      text: doc.doc.text,
      savedText: doc.savedText,
      selections: doc.selections,
      scrollTop: doc.scrollTop,
      lineEnding: doc.doc.eol,
      readOnly: doc.readOnly,
      modifiedAt: Date.now(),
    }));
    saveSession(localStorage, documents, this.activeId);
  }

  private writeJournalSnapshot(): void {
    const dirty = this.documents.filter((doc) => this.isDirty(doc));
    if (dirty.length === 0) {
      if (localStorage.getItem(JOURNAL_KEY)) clearJournal(localStorage);
      return;
    }
    writeJournal(
      localStorage,
      dirty.map((doc) => ({
        id: doc.id,
        name: doc.name,
        language: doc.languageId,
        text: doc.doc.text,
        selections: doc.selections,
        updatedAt: Date.now(),
      })),
    );
  }

  private restoreSettings(): void {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as Partial<Settings>;
      this.settings = { ...DEFAULT_SETTINGS, ...parsed };
    } catch {
      this.settings = { ...DEFAULT_SETTINGS };
    }
  }

  private saveSettings(): void {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(this.settings));
    } catch {
      /* private mode */
    }
  }

  private applyTheme(): void {
    const theme =
      this.settings.theme === 'system'
        ? window.matchMedia?.('(prefers-color-scheme: light)').matches
          ? 'light'
          : 'dark'
        : this.settings.theme;
    document.documentElement.dataset['theme'] = theme;
  }

  private setSettings(patch: Partial<Settings>): void {
    this.settings = { ...this.settings, ...patch };
    this.saveSettings();
    this.applyTheme();
    this.render({ syncSelection: false });
  }

  /* -------------------------------------------------------------- commands */

  private registerCommands(): void {
    const hasDoc = () => this.active !== undefined;
    const editable = () => this.active !== undefined && !this.active.readOnly;
    const keys = (id: string): string[] => Object.entries(DEFAULT_BINDINGS).filter(([, command]) => command === id).map(([combo]) => combo);

    this.registry.registerAll([
      { id: 'file.new', title: 'New file', category: 'File', keys: keys('file.new'), run: () => this.newFile() },
      { id: 'file.open', title: 'Open file…', category: 'File', keys: keys('file.open'), run: () => this.openFile() },
      { id: 'file.save', title: 'Save', category: 'File', keys: keys('file.save'), run: () => this.save() },
      { id: 'file.saveAs', title: 'Save as…', category: 'File', keys: keys('file.saveAs'), run: () => this.saveAs() },
      {
        id: 'file.close',
        title: 'Close file',
        category: 'File',
        keys: keys('file.close'),
        enabled: hasDoc,
        run: () => this.active && this.closeDocument(this.active.id),
      },
      { id: 'file.toggleLineEnding', title: 'Toggle line endings (LF/CRLF)', category: 'File', run: () => this.toggleLineEnding() },
      { id: 'palette.commands', title: 'Command palette', category: 'View', keys: keys('palette.commands'), run: () => this.commandPalette() },
      { id: 'palette.quickOpen', title: 'Go to file…', category: 'View', keys: keys('palette.quickOpen'), run: () => this.quickOpen() },
      { id: 'goto.line', title: 'Go to line…', category: 'Navigation', keys: keys('goto.line'), enabled: hasDoc, run: () => this.gotoLine() },
      { id: 'find.open', title: 'Find', category: 'Find', keys: keys('find.open'), enabled: hasDoc, run: () => this.openFind(false) },
      { id: 'find.replace', title: 'Find and replace', category: 'Find', keys: keys('find.replace'), enabled: hasDoc, run: () => this.openFind(true) },
      { id: 'find.next', title: 'Find next match', category: 'Find', enabled: editable, run: () => this.findNext(1) },
      { id: 'find.previous', title: 'Find previous match', category: 'Find', enabled: editable, run: () => this.findNext(-1) },
      { id: 'history.undo', title: 'Undo', category: 'Edit', keys: keys('history.undo'), enabled: editable, run: () => this.undo() },
      { id: 'history.redo', title: 'Redo', category: 'Edit', keys: keys('history.redo'), enabled: editable, run: () => this.redo() },
      { id: 'select.all', title: 'Select all', category: 'Edit', keys: keys('select.all'), enabled: hasDoc, run: () => this.selectAll() },
      { id: 'edit.indent', title: 'Indent selection', category: 'Edit', keys: keys('edit.indent'), enabled: editable, run: () => this.indentSelection('indent') },
      { id: 'edit.outdent', title: 'Outdent selection', category: 'Edit', keys: keys('edit.outdent'), enabled: editable, run: () => this.indentSelection('outdent') },
      { id: 'edit.moveLineUp', title: 'Move line up', category: 'Edit', keys: keys('edit.moveLineUp'), enabled: editable, run: () => this.moveLines(-1) },
      { id: 'edit.moveLineDown', title: 'Move line down', category: 'Edit', keys: keys('edit.moveLineDown'), enabled: editable, run: () => this.moveLines(1) },
      { id: 'edit.duplicateLine', title: 'Duplicate line', category: 'Edit', keys: keys('edit.duplicateLine'), enabled: editable, run: () => this.duplicateLines() },
      { id: 'edit.duplicateLineUp', title: 'Duplicate line up', category: 'Edit', keys: keys('edit.duplicateLineUp'), enabled: editable, run: () => this.duplicateLines() },
      { id: 'edit.deleteLine', title: 'Delete line', category: 'Edit', keys: keys('edit.deleteLine'), enabled: editable, run: () => this.deleteLines() },
      { id: 'edit.toggleComment', title: 'Toggle line comment', category: 'Edit', keys: keys('edit.toggleComment'), enabled: editable, run: () => this.toggleComment() },
      { id: 'cursor.addAbove', title: 'Add cursor above', category: 'Selection', keys: keys('cursor.addAbove'), enabled: hasDoc, run: () => this.addCursor('up') },
      { id: 'cursor.addBelow', title: 'Add cursor below', category: 'Selection', keys: keys('cursor.addBelow'), enabled: hasDoc, run: () => this.addCursor('down') },
      { id: 'cursor.addNextOccurrence', title: 'Add next occurrence to selection', category: 'Selection', keys: keys('cursor.addNextOccurrence'), enabled: hasDoc, run: () => this.addNextOccurrence() },
      { id: 'cursor.escape', title: 'Collapse to a single cursor', category: 'Selection', enabled: hasDoc, run: () => this.escapeSelection() },
      { id: 'view.toggleWrap', title: 'Toggle word wrap', category: 'View', run: () => this.toggleWrap() },
      { id: 'view.toggleLineNumbers', title: 'Toggle line numbers', category: 'View', run: () => this.setSettings({ lineNumbers: !this.settings.lineNumbers }) },
      { id: 'view.toggleHighlight', title: 'Toggle syntax highlighting', category: 'View', run: () => this.setSettings({ highlight: !this.settings.highlight }) },
      { id: 'view.toggleTheme', title: 'Toggle theme', category: 'View', run: () => this.toggleTheme() },
      { id: 'view.zoomIn', title: 'Zoom in', category: 'View', keys: keys('view.zoomIn'), run: () => this.zoom(1) },
      { id: 'view.zoomOut', title: 'Zoom out', category: 'View', keys: keys('view.zoomOut'), run: () => this.zoom(-1) },
      { id: 'view.zoomReset', title: 'Reset zoom', category: 'View', keys: keys('view.zoomReset'), run: () => this.setSettings({ fontSize: 14 }) },
    ]);
  }

  private toggleWrap(): void {
    const active = this.active;
    if (!active) return;
    active.wrapOverride = !this.wrapEnabled(active);
    this.render({ syncSelection: false });
  }

  private toggleTheme(): void {
    const current = document.documentElement.dataset['theme'] === 'light' ? 'dark' : 'light';
    this.setSettings({ theme: current });
  }

  private zoom(direction: 1 | -1): void {
    this.setSettings({ fontSize: Math.min(24, Math.max(10, this.settings.fontSize + direction)) });
  }
}


/** Word (identifier-ish) around an offset, used to seed select-next-occurrence. */
export function wordAt(text: string, offset: number): { from: number; to: number } | null {
  const isWord = (char: string | undefined) => char !== undefined && /[\p{L}\p{N}_$]/u.test(char);
  let at = offset;
  if (!isWord(text[at])) {
    if (!isWord(text[at - 1])) return null;
    at -= 1;
  }
  let from = at;
  while (from > 0 && isWord(text[from - 1])) from -= 1;
  let to = at + 1;
  while (to < text.length && isWord(text[to])) to += 1;
  return { from, to };
}
