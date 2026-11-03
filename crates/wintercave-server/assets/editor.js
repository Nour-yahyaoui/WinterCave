/*
 * WinterCave — the thin client.
 *
 * All of the editor's thinking lives in Rust: this file carries text between the
 * page, the highlight/completion endpoints and the file API, and it renders the
 * small dialogs. Plain JavaScript on purpose — no framework, no bundler, no
 * build step — and the page still works without it through the <form> fallback.
 */
(() => {
  'use strict';

  const root = document.documentElement;
  const body = document.body;
  const themeButton = document.getElementById('theme-toggle');
  const themeLabel = document.getElementById('theme-label');
  const themeMedia = window.matchMedia ? window.matchMedia('(prefers-color-scheme: light)') : null;

  const STORAGE_KEY = 'wintercave.theme';

  /* ---- theme ---------------------------------------------------------- */

  function storedTheme() {
    try {
      const value = localStorage.getItem(STORAGE_KEY);
      return value === 'light' || value === 'dark' || value === 'system' ? value : '';
    } catch {
      return '';
    }
  }

  function applyTheme(theme, remember) {
    const resolved = theme === 'system'
      ? (themeMedia && themeMedia.matches ? 'light' : 'dark')
      : (theme === 'light' ? 'light' : 'dark');
    root.dataset.theme = resolved;
    if (remember) {
      try {
        localStorage.setItem(STORAGE_KEY, theme === 'system' ? 'system' : resolved);
      } catch {
        /* private mode: the choice just does not persist */
      }
    }
    if (themeButton) {
      themeButton.setAttribute('aria-pressed', root.dataset.theme === 'light' ? 'true' : 'false');
      themeButton.title = 'Switch to the ' + (root.dataset.theme === 'light' ? 'dark' : 'light') + ' theme';
    }
    if (themeLabel) {
      themeLabel.textContent = root.dataset.theme === 'light' ? 'Dark' : 'Light';
    }
  }

  // The inline <head> script already chose; this syncs controls and supports
  // following the system appearance when that preference is selected.
  const initialTheme = storedTheme() || 'system';
  applyTheme(initialTheme, false);

  if (themeButton) {
    themeButton.addEventListener('click', () => {
      applyTheme(root.dataset.theme === 'light' ? 'dark' : 'light', true);
      if (themeSelect) themeSelect.value = storedTheme() || root.dataset.theme;
    });
  }

  if (themeMedia && themeMedia.addEventListener) {
    themeMedia.addEventListener('change', () => {
      const choice = storedTheme();
      if (!choice || choice === 'system') applyTheme('system', false);
    });
  }

  const settingsDialog = document.getElementById('settings');
  const aboutDialog = document.getElementById('about');
  const settingsButton = document.getElementById('open-settings');
  const aboutButton = document.getElementById('open-about');
  const themeSelect = document.getElementById('setting-theme');
  const fontSizeSelect = document.getElementById('setting-font-size');
  const tabSizeSelect = document.getElementById('setting-tab-size');
  const wrapSelect = document.getElementById('setting-wrap');

  function readPreference(key, allowed, fallback) {
    try {
      const value = localStorage.getItem('wintercave.' + key);
      return allowed.includes(value) ? value : fallback;
    } catch {
      return fallback;
    }
  }

  function savePreference(key, value) {
    try { localStorage.setItem('wintercave.' + key, value); } catch { /* storage is optional */ }
  }

  if (themeSelect) {
    themeSelect.value = initialTheme;
    themeSelect.addEventListener('change', () => applyTheme(themeSelect.value, true));
  }
  if (fontSizeSelect) {
    fontSizeSelect.value = readPreference('font-size', ['12', '13', '14', '15', '16', '18'], '13');
    root.style.setProperty('--editor-size', fontSizeSelect.value + 'px');
    fontSizeSelect.addEventListener('change', () => {
      root.style.setProperty('--editor-size', fontSizeSelect.value + 'px');
      savePreference('font-size', fontSizeSelect.value);
    });
  }
  if (tabSizeSelect) {
    tabSizeSelect.value = readPreference('tab-size', ['2', '4', '8'], '2');
    root.style.setProperty('--editor-tab-size', tabSizeSelect.value);
    tabSizeSelect.addEventListener('change', () => {
      root.style.setProperty('--editor-tab-size', tabSizeSelect.value);
      savePreference('tab-size', tabSizeSelect.value);
    });
  }
  if (wrapSelect) {
    wrapSelect.checked = readPreference('wrap', ['true', 'false'], 'false') === 'true';
    wrapSelect.addEventListener('change', () => {
      document.querySelector('.wrap')?.classList.toggle('wrapped', wrapSelect.checked);
      savePreference('wrap', String(wrapSelect.checked));
    });
  }
  document.querySelector('.wrap')?.classList.toggle('wrapped', wrapSelect && wrapSelect.checked);

  if (settingsButton && settingsDialog) settingsButton.addEventListener('click', () => settingsDialog.showModal());
  if (aboutButton && aboutDialog) aboutButton.addEventListener('click', () => aboutDialog.showModal());

  /* ---- sidebar resize ----------------------------------------------- */
  const resizeHandle = document.getElementById('sidebar-resize');
  const MIN_SIDEBAR = 200;
  const MAX_SIDEBAR = 520;
  const SIDEBAR_KEY = 'wintercave.sidebar-width';

  function setSidebarWidth(value, persist) {
    const max = Math.min(MAX_SIDEBAR, Math.max(MIN_SIDEBAR, window.innerWidth - 320));
    const width = Math.round(Math.max(MIN_SIDEBAR, Math.min(max, value)));
    root.style.setProperty('--sidebar-width', width + 'px');
    if (resizeHandle) resizeHandle.setAttribute('aria-valuenow', String(width));
    if (persist) savePreference('sidebar-width', String(width));
  }

  let storedWidth = '262';
  try { storedWidth = localStorage.getItem('wintercave.sidebar-width') || storedWidth; } catch { /* storage is optional */ }
  const parsedWidth = Number.parseInt(storedWidth, 10);
  setSidebarWidth(Number.isFinite(parsedWidth) ? parsedWidth : 262, false);

  if (resizeHandle) {
    let resizing = false;
    resizeHandle.addEventListener('pointerdown', (event) => {
      if (window.innerWidth <= 720) return;
      resizing = true;
      resizeHandle.setPointerCapture(event.pointerId);
      document.body.classList.add('is-resizing');
      setSidebarWidth(event.clientX, false);
      event.preventDefault();
    });
    resizeHandle.addEventListener('pointermove', (event) => {
      if (resizing) setSidebarWidth(event.clientX, false);
    });
    const finishResize = () => {
      if (!resizing) return;
      resizing = false;
      document.body.classList.remove('is-resizing');
      const width = Number.parseInt(getComputedStyle(root).getPropertyValue('--sidebar-width'), 10);
      setSidebarWidth(width, true);
    };
    resizeHandle.addEventListener('pointerup', finishResize);
    resizeHandle.addEventListener('pointercancel', finishResize);
    resizeHandle.addEventListener('keydown', (event) => {
      const current = Number.parseInt(getComputedStyle(root).getPropertyValue('--sidebar-width'), 10);
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault();
        setSidebarWidth(current + (event.key === 'ArrowRight' ? 16 : -16), true);
      } else if (event.key === 'Home' || event.key === 'End') {
        event.preventDefault();
        setSidebarWidth(event.key === 'Home' ? MIN_SIDEBAR : MAX_SIDEBAR, true);
      }
    });
  }

  /* ---- editor --------------------------------------------------------- */

  const textarea = document.getElementById('editor');
  const highlight = document.getElementById('highlight');
  const statusEl = document.getElementById('status');
  const positionEl = document.getElementById('position');
  const fallback = document.getElementById('fallback');

  if (!textarea || !highlight) return;

  let path = body.dataset.path || '';
  const folder = body.dataset.dir || '';
  let language = body.dataset.language || 'plaintext';
  let readOnly = body.dataset.readOnly === 'true';
  let localRootHandle = null;
  let activeFileHandle = null;
  let externalMode = false;
  const localFileHandles = new Map();
  const MAX_HIGHLIGHT = 400000;

  // The script is alive: the no-JavaScript save button is not needed any more.
  if (fallback) fallback.hidden = true;

  let saved = textarea.value;
  let timer = 0;
  let generation = 0;
  let saveInFlight = false;
  let saveQueued = false;

  function setStatus(text, tone) {
    if (!statusEl) return;
    statusEl.textContent = text;
    if (tone) statusEl.dataset.tone = tone;
    else delete statusEl.dataset.tone;
  }

  const dirty = () => textarea.value !== saved;

  function syncScroll() {
    highlight.scrollTop = textarea.scrollTop;
    highlight.scrollLeft = textarea.scrollLeft;
  }

  function refreshStatus() {
    if (dirty()) setStatus('unsaved', 'dirty');
    else if (readOnly) setStatus('read only');
    else setStatus('saved');
  }

  function updatePosition() {
    if (!positionEl) return;
    const upto = textarea.value.slice(0, textarea.selectionStart);
    const line = upto.split('\n').length;
    const column = upto.length - (upto.lastIndexOf('\n') + 1) + 1;
    positionEl.textContent = line + ':' + column;
  }

  async function renderHighlight() {
    if (completionOpen()) return; // the popup already shows the words
    const mine = ++generation;

    if (textarea.value.length > MAX_HIGHLIGHT) {
      highlight.textContent = textarea.value;
      syncScroll();
      return;
    }

    try {
      const response = await fetch('/api/highlight', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: textarea.value, language: language, path: path }),
      });
      if (!response.ok) {
        setStatus('highlight failed', 'warn');
        return;
      }
      const data = await response.json();
      if (mine !== generation) return; // a newer keystroke already asked
      highlight.innerHTML = data.html;
      syncScroll();
    } catch {
      setStatus('offline', 'warn');
    }
  }

  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(renderHighlight, 120);
  }

  async function save() {
    if (readOnly) {
      setStatus('read only', 'warn');
      return;
    }
    // Never let overlapping requests reach the server out of order. A second
    // save keystroke while one is pending queues exactly one fresh snapshot.
    if (saveInFlight) {
      saveQueued = true;
      return;
    }

    const snapshot = textarea.value;
    saveInFlight = true;
    setStatus('saving…', 'dirty');
    try {
      if (activeFileHandle) {
        const writable = await activeFileHandle.createWritable();
        await writable.write(snapshot);
        await writable.close();
        saved = snapshot;
        refreshStatus();
      } else {
        const response = await fetch('/api/files?path=' + encodeURIComponent(path), {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text: snapshot }),
        });
        if (!response.ok) {
          const problem = await response.json().catch(() => ({}));
          setStatus((problem.error && problem.error.message) || 'save failed', 'warn');
        } else {
          // Only mark the bytes sent in this request as saved. If typing continued
          // while it was in flight, refreshStatus leaves the new buffer dirty.
          saved = snapshot;
          refreshStatus();
        }
      }
    } catch (error) {
      setStatus(error && error.message ? 'save failed: ' + error.message : 'save failed', 'warn');
    } finally {
      saveInFlight = false;
      if (saveQueued) {
        saveQueued = false;
        save();
      }
    }
  }

  /* ---- completion ------------------------------------------------------ */

  const completionEl = document.getElementById('completion');
  const WORD_PREFIX = /[A-Za-z0-9_$\u00c0-\uffff]+$/;

  let completionItems = [];
  let completionIndex = 0;
  let completionRange = null;
  let completionTimer = 0;
  let completionToken = 0;

  function completionOpen() {
    return Boolean(completionEl) && !completionEl.hidden;
  }

  function hideCompletion() {
    completionToken += 1;
    completionItems = [];
    completionRange = null;
    if (!completionEl) return;
    completionEl.hidden = true;
    completionEl.textContent = '';
  }

  /*
   * Where the caret is, in the coordinate space of `.wrap` (the textarea's
   * offset parent). A hidden mirror carrying the same box metrics is the only
   * reliable way to measure a textarea caret — the element reports no geometry
   * of its own.
   */
  function caretPoint() {
    const style = getComputedStyle(textarea);
    const mirror = document.createElement('div');
    const inherited = [
      'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'lineHeight',
      'letterSpacing', 'textTransform', 'tabSize', 'paddingTop', 'paddingRight',
      'paddingBottom', 'paddingLeft', 'borderTopWidth', 'borderLeftWidth',
    ];
    for (const property of inherited) mirror.style[property] = style[property];
    mirror.style.position = 'absolute';
    mirror.style.top = '0';
    mirror.style.left = '0';
    mirror.style.width = textarea.clientWidth + 'px';
    mirror.style.whiteSpace = 'pre';
    mirror.style.overflow = 'hidden';
    mirror.style.visibility = 'hidden';
    mirror.textContent = textarea.value.slice(0, textarea.selectionStart);

    const marker = document.createElement('span');
    marker.textContent = '\u200b';
    mirror.appendChild(marker);
    document.body.appendChild(mirror);

    const point = {
      top: marker.offsetTop,
      left: marker.offsetLeft,
      lineHeight: parseFloat(style.lineHeight) || 20,
    };
    document.body.removeChild(mirror);

    point.top = point.top - textarea.scrollTop + point.lineHeight;
    point.left = point.left - textarea.scrollLeft;
    return point;
  }

  function positionCompletion() {
    if (!completionEl) return;
    const wrap = textarea.parentElement;
    if (!wrap) return;
    const point = caretPoint();
    const width = completionEl.offsetWidth || 200;
    const height = completionEl.offsetHeight || 120;
    const maxLeft = Math.max(8, wrap.clientWidth - width - 8);
    const maxTop = Math.max(8, wrap.clientHeight - height - 8);

    completionEl.style.left = Math.max(8, Math.min(point.left, maxLeft)) + 'px';
    completionEl.style.top = Math.max(8, Math.min(point.top, maxTop)) + 'px';
  }

  function highlightCompletion(index) {
    const rows = completionEl.children;
    for (let row = 0; row < rows.length; row += 1) {
      rows[row].setAttribute('aria-selected', row === index ? 'true' : 'false');
    }
    completionIndex = index;
    const active = rows[index];
    if (active && active.scrollIntoView) active.scrollIntoView({ block: 'nearest' });
  }

  function acceptCompletion(index) {
    const item = completionItems[index === undefined ? completionIndex : index];
    if (!item || !completionRange) return;
    textarea.setRangeText(item.label, completionRange.from, completionRange.to, 'end');
    hideCompletion();
    refreshStatus();
    updatePosition();
    schedule();
    textarea.focus();
  }

  function showCompletion(data, caret) {
    if (!completionEl || !data.items || !data.items.length) {
      hideCompletion();
      return;
    }
    if (textarea.selectionStart !== caret || textarea.selectionEnd !== caret) {
      hideCompletion();
      return;
    }

    completionItems = data.items;
    completionRange = { from: data.from, to: data.to };
    completionEl.textContent = '';

    data.items.forEach((item, index) => {
      const row = document.createElement('li');
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', index === 0 ? 'true' : 'false');

      const label = document.createElement('span');
      label.className = 'label';
      label.textContent = item.label;

      const kind = document.createElement('span');
      kind.className = 'kind';
      kind.textContent = item.kind;

      row.append(label, kind);
      // mousedown, not click: the textarea must not lose the caret first.
      row.addEventListener('mousedown', (event) => {
        event.preventDefault();
        acceptCompletion(index);
      });
      completionEl.appendChild(row);
    });

    completionIndex = 0;
    completionEl.hidden = false;
    positionCompletion();
  }

  async function requestCompletion(force) {
    if (readOnly) return;

    const caret = textarea.selectionStart;
    if (caret !== textarea.selectionEnd) {
      hideCompletion();
      return;
    }

    const before = textarea.value.slice(0, caret);
    const found = before.match(WORD_PREFIX);
    const prefix = found ? found[0] : '';
    if (!force && prefix.length < 2) {
      hideCompletion();
      return;
    }
    if (prefix.length < 1 || textarea.value.length > MAX_HIGHLIGHT) {
      hideCompletion();
      return;
    }

    const token = ++completionToken;
    try {
      const response = await fetch('/api/complete', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          text: textarea.value,
          offset: caret,
          language: language,
          path: path,
        }),
      });
      if (token !== completionToken) return;
      if (!response.ok) {
        hideCompletion();
        return;
      }
      const data = await response.json();
      if (token !== completionToken) return;
      showCompletion(data, caret);
    } catch {
      hideCompletion();
    }
  }

  function scheduleCompletion() {
    clearTimeout(completionTimer);
    completionTimer = setTimeout(() => requestCompletion(false), 110);
  }

  /* ---- local folders selected by the user ----------------------------- */

  const localFolderButton = document.getElementById('open-local-folder');
  const workspaceFiles = document.getElementById('workspace-files');
  const workspaceCrumbs = document.getElementById('workspace-crumbs');
  const workspaceRoot = document.getElementById('workspace-root');
  const currentName = document.getElementById('current-name');
  const currentLanguage = document.getElementById('current-language');
  const languageDisplay = document.getElementById('language-display');

  function localLanguage(filename) {
    const extension = filename.toLowerCase().split('.').pop();
    const languages = {
      rs: 'rust', js: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript',
      py: 'python', sh: 'shell', bash: 'shell', yml: 'yaml', yaml: 'yaml', sql: 'sql',
      json: 'json', html: 'html', htm: 'html', css: 'css', md: 'markdown', mdx: 'markdown',
    };
    return languages[extension] || 'plaintext';
  }

  async function localDirectoryAt(relative) {
    let directory = localRootHandle;
    for (const part of (relative || '').split('/').filter(Boolean)) {
      directory = await directory.getDirectoryHandle(part);
    }
    return directory;
  }

  function paintLocalCrumbs(relative) {
    if (!workspaceCrumbs || !localRootHandle) return;
    workspaceCrumbs.textContent = '';
    const rootLink = document.createElement('a');
    rootLink.href = '#';
    rootLink.textContent = localRootHandle.name;
    rootLink.addEventListener('click', (event) => {
      event.preventDefault();
      renderLocalFolder('');
    });
    workspaceCrumbs.appendChild(rootLink);
    let walked = '';
    relative.split('/').filter(Boolean).forEach((part) => {
      walked = walked ? walked + '/' + part : part;
      const crumb = document.createElement('a');
      crumb.href = '#';
      crumb.textContent = part;
      crumb.addEventListener('click', (event) => {
        event.preventDefault();
        renderLocalFolder(walked);
      });
      const separator = document.createElement('span');
      separator.className = 'sep';
      separator.textContent = '/';
      workspaceCrumbs.append(separator, crumb);
    });
  }

  async function renderLocalFolder(relative) {
    if (!localRootHandle || !workspaceFiles) return;
    try {
      const directory = await localDirectoryAt(relative);
      const entries = [];
      for await (const [name, handle] of directory.entries()) {
        entries.push({ name, handle, kind: handle.kind });
      }
      entries.sort((a, b) => {
        if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1;
        return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
      });

      workspaceFiles.textContent = '';
      localFileHandles.clear();
      if (relative) {
        const parent = relative.includes('/') ? relative.slice(0, relative.lastIndexOf('/')) : '';
        const up = document.createElement('li');
        const link = document.createElement('a');
        link.className = 'dir up';
        link.href = '#';
        link.dataset.localDirectory = parent;
        link.textContent = '../';
        up.appendChild(link);
        workspaceFiles.appendChild(up);
      }
      for (const entry of entries) {
        const entryPath = relative ? relative + '/' + entry.name : entry.name;
        const row = document.createElement('li');
        const link = document.createElement('a');
        link.href = '#';
        link.textContent = entry.kind === 'directory' ? entry.name + '/' : entry.name;
        if (entry.kind === 'directory') {
          link.className = 'dir';
          link.dataset.localDirectory = entryPath;
        } else {
          link.className = 'file';
          link.dataset.localFile = entryPath;
          localFileHandles.set(entryPath, entry.handle);
          if (entryPath === path) link.classList.add('current');
        }
        row.appendChild(link);
        workspaceFiles.appendChild(row);
      }
      if (!entries.length) {
        const empty = document.createElement('li');
        empty.className = 'empty';
        empty.textContent = 'no files here';
        workspaceFiles.appendChild(empty);
      }
      browseDir = relative;
      paintLocalCrumbs(relative);
      if (workspaceRoot) {
        workspaceRoot.textContent = localRootHandle.name;
        workspaceRoot.title = 'Folder selected in this browser';
      }
    } catch (error) {
      setStatus('Could not read that folder', 'warn');
    }
  }

  async function openLocalFile(relative) {
    const handle = localFileHandles.get(relative);
    if (!handle) return;
    if (saveInFlight) {
      setStatus('Wait for the current save to finish', 'warn');
      return;
    }
    if (dirty() && !window.confirm('Discard unsaved changes and open another file?')) return;
    try {
      const file = await handle.getFile();
      if (file.size > 10000000) {
        setStatus('File exceeds the 10 MB editor limit', 'warn');
        return;
      }
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (bytes.subarray(0, Math.min(bytes.length, 8000)).includes(0)) {
        setStatus('That file looks binary', 'warn');
        return;
      }
      let text;
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      } catch {
        setStatus('That file is not valid UTF-8', 'warn');
        return;
      }
      generation += 1;
      activeFileHandle = handle;
      path = relative;
      language = localLanguage(file.name);
      readOnly = false;
      textarea.value = text;
      saved = text;
      if (currentName) currentName.textContent = file.name;
      if (currentLanguage) currentLanguage.textContent = language;
      if (languageDisplay) languageDisplay.textContent = language;
      renderLocalFolder(relative.includes('/') ? relative.slice(0, relative.lastIndexOf('/')) : '');
      refreshStatus();
      updatePosition();
      hideCompletion();
      schedule();
      textarea.focus();
    } catch (error) {
      setStatus('Could not open file: ' + (error.message || 'permission denied'), 'warn');
    }
  }

  async function chooseLocalFolder() {
    if (saveInFlight) {
      setStatus('Wait for the current save to finish', 'warn');
      return;
    }
    if (typeof window.showDirectoryPicker !== 'function') {
      setStatus('Choose a folder from this PC in Chrome or Edge', 'warn');
      return;
    }
    if (dirty() && !window.confirm('Discard unsaved changes and choose another folder?')) return;
    try {
      localRootHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
      externalMode = true;
      generation += 1;
      activeFileHandle = null;
      path = '';
      language = 'plaintext';
      readOnly = false;
      textarea.value = '';
      saved = '';
      if (currentName) currentName.textContent = 'no file open';
      if (currentLanguage) currentLanguage.textContent = language;
      if (languageDisplay) languageDisplay.textContent = language;
      if (workspaceFiles) workspaceFiles.dataset.source = 'local';
      refreshStatus();
      updatePosition();
      renderLocalFolder('');
      schedule();
    } catch (error) {
      if (error.name !== 'AbortError') setStatus('Folder access was not granted', 'warn');
    }
  }

  if (localFolderButton) localFolderButton.addEventListener('click', chooseLocalFolder);
  if (workspaceFiles) {
    workspaceFiles.addEventListener('click', (event) => {
      const link = event.target.closest('a');
      if (!link || !externalMode) return;
      if (link.dataset.localDirectory !== undefined) {
        event.preventDefault();
        renderLocalFolder(link.dataset.localDirectory);
      } else if (link.dataset.localFile) {
        event.preventDefault();
        openLocalFile(link.dataset.localFile);
      }
    });
  }

  /* ---- open file (quick open) ------------------------------------------ */

  const quickDialog = document.getElementById('quick-open');
  const quickInput = document.getElementById('quick-input');
  const quickResults = document.getElementById('quick-results');

  let quickItems = [];
  let quickIndex = 0;
  let quickTimer = 0;
  let quickToken = 0;

  async function goToFile(relative) {
    if (externalMode) {
      await openLocalFile(relative);
      if (quickDialog) quickDialog.close();
      return;
    }
    const parameters = new URLSearchParams();
    parameters.set('path', relative);
    const cut = relative.lastIndexOf('/');
    // Follow the file: the sidebar opens in the folder that holds it.
    if (cut > 0) parameters.set('dir', relative.slice(0, cut));
    window.location.href = '/?' + parameters.toString();
  }

  function paintQuickSelection() {
    if (!quickResults) return;
    const rows = quickResults.querySelectorAll('button');
    rows.forEach((row, index) => {
      row.setAttribute('aria-selected', index === quickIndex ? 'true' : 'false');
      if (index === quickIndex && row.scrollIntoView) row.scrollIntoView({ block: 'nearest' });
    });
  }

  function paintQuickResults(items, note) {
    quickItems = items;
    quickIndex = 0;
    if (!quickResults) return;
    quickResults.textContent = '';

    if (!items.length) {
      const empty = document.createElement('li');
      empty.className = 'empty';
      empty.textContent = note || 'no files match';
      quickResults.appendChild(empty);
      return;
    }

    items.forEach((item, index) => {
      const row = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.setAttribute('role', 'option');
      button.setAttribute('aria-selected', index === 0 ? 'true' : 'false');

      const name = document.createElement('span');
      name.textContent = item.name;

      const where = document.createElement('span');
      where.className = 'where';
      const parts = item.path.split('/');
      parts.pop();
      where.textContent = parts.length ? parts.join('/') + '/' : folder || './';

      button.append(name, where);
      button.addEventListener('click', () => goToFile(item.path));
      row.appendChild(button);
      quickResults.appendChild(row);
    });
  }

  async function searchFiles(query) {
    const token = ++quickToken;
    if (externalMode) {
      const needle = query.toLocaleLowerCase();
      const matches = Array.from(localFileHandles.keys())
        .filter((itemPath) => !needle || itemPath.toLocaleLowerCase().includes(needle))
        .slice(0, 60)
        .map((itemPath) => ({ path: itemPath, name: itemPath.split('/').pop() }));
      paintQuickResults(matches, 'no files in this folder match');
      return;
    }
    try {
      const response = await fetch('/api/find', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: query, dir: folder, limit: 60 }),
      });
      if (token !== quickToken) return;
      if (!response.ok) {
        paintQuickResults([], 'could not list files');
        return;
      }
      const data = await response.json();
      if (token !== quickToken) return;
      paintQuickResults(data.items || []);
    } catch {
      paintQuickResults([], 'offline — the server is not answering');
    }
  }

  function openQuickOpen() {
    if (!quickDialog || typeof quickDialog.showModal !== 'function') return;
    if (quickDialog.open) {
      if (quickInput) quickInput.focus();
      return;
    }
    hideCompletion();
    quickDialog.showModal();
    if (quickInput) {
      quickInput.value = '';
      quickInput.focus();
    }
    searchFiles('');
  }

  if (quickInput) {
    quickInput.addEventListener('input', () => {
      clearTimeout(quickTimer);
      const value = quickInput.value;
      quickTimer = setTimeout(() => searchFiles(value), 120);
    });
    quickInput.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        if (!quickItems.length) return;
        const step = event.key === 'ArrowDown' ? 1 : -1;
        quickIndex = (quickIndex + step + quickItems.length) % quickItems.length;
        paintQuickSelection();
      } else if (event.key === 'Enter') {
        event.preventDefault();
        const chosen = quickItems[quickIndex];
        if (chosen) goToFile(chosen.path);
      }
    });
  }

  /* ---- open folder ----------------------------------------------------- */

  const folderDialog = document.getElementById('folder-browser');
  const folderResults = document.getElementById('folder-results');
  const folderCrumbs = document.getElementById('folder-crumbs');
  const folderOpen = document.getElementById('folder-open');

  let browseDir = folder;

  function paintFolderCrumbs() {
    if (!folderCrumbs) return;
    folderCrumbs.textContent = '';

    const rootLink = document.createElement('a');
    rootLink.href = '/';
    rootLink.textContent = 'workspace';
    rootLink.addEventListener('click', (event) => {
      event.preventDefault();
      browseFolder('');
    });
    folderCrumbs.appendChild(rootLink);

    let walked = '';
    browseDir.split('/').filter(Boolean).forEach((part) => {
      walked = walked ? walked + '/' + part : part;
      const target = walked;

      const separator = document.createElement('span');
      separator.className = 'sep';
      separator.textContent = '/';

      const link = document.createElement('a');
      link.href = '/?dir=' + encodeURIComponent(target);
      link.textContent = part;
      link.addEventListener('click', (event) => {
        event.preventDefault();
        browseFolder(target);
      });

      folderCrumbs.append(separator, link);
    });
  }

  async function browseFolder(relative) {
    browseDir = relative || '';
    paintFolderCrumbs();
    if (!folderResults) return;

    folderResults.textContent = '';
    const loading = document.createElement('li');
    loading.className = 'empty';
    loading.textContent = 'listing…';
    folderResults.appendChild(loading);

    try {
      const response = await fetch('/api/tree?path=' + encodeURIComponent(browseDir));
      if (!response.ok) {
        folderResults.textContent = '';
        const failed = document.createElement('li');
        failed.className = 'empty';
        failed.textContent = 'could not list that folder';
        folderResults.appendChild(failed);
        return;
      }
      const data = await response.json();
      folderResults.textContent = '';
      const folders = (data.entries || []).filter((entry) => entry.kind === 'dir');

      if (!folders.length) {
        const empty = document.createElement('li');
        empty.className = 'empty';
        empty.textContent = 'no folders inside';
        folderResults.appendChild(empty);
      }

      folders.forEach((entry) => {
        const row = document.createElement('li');
        const button = document.createElement('button');
        button.type = 'button';
        button.setAttribute('role', 'option');
        button.addEventListener('click', () => browseFolder(entry.path));

        const name = document.createElement('span');
        name.textContent = entry.name + '/';

        const hint = document.createElement('span');
        hint.className = 'where';
        hint.textContent = 'open';

        button.append(name, hint);
        row.appendChild(button);
        folderResults.appendChild(row);
      });
    } catch {
      folderResults.textContent = '';
      const offline = document.createElement('li');
      offline.className = 'empty';
      offline.textContent = 'offline — the server is not answering';
      folderResults.appendChild(offline);
    }
  }

  function openFolderBrowser() {
    if (!folderDialog || typeof folderDialog.showModal !== 'function') return;
    if (folderDialog.open) return;
    hideCompletion();
    folderDialog.showModal();
    browseFolder(folder);
  }

  if (folderOpen) {
    folderOpen.addEventListener('click', () => {
      const parameters = new URLSearchParams();
      if (browseDir) parameters.set('dir', browseDir);
      window.location.href = '/' + (browseDir ? '?' + parameters.toString() : '');
    });
  }

  const openFileButton = document.getElementById('open-file');
  const openFolderButton = document.getElementById('open-folder');
  if (openFileButton) openFileButton.addEventListener('click', openQuickOpen);
  if (openFolderButton) openFolderButton.addEventListener('click', openFolderBrowser);

  document.querySelectorAll('dialog [data-close]').forEach((button) => {
    button.addEventListener('click', () => {
      const dialog = button.closest('dialog');
      if (dialog) dialog.close();
    });
  });

  if (quickDialog) {
    quickDialog.addEventListener('close', () => {
      if (quickInput) quickInput.value = '';
    });
  }

  /* ---- keyboard -------------------------------------------------------- */

  window.addEventListener('keydown', (event) => {
    const mod = event.metaKey || event.ctrlKey;
    if (!mod) return;
    const key = event.key.toLowerCase();

    if (key === 'p' && !event.shiftKey) {
      event.preventDefault();
      openQuickOpen();
      return;
    }
    if (key === 'o' && event.shiftKey) {
      event.preventDefault();
      openFolderBrowser();
    }
  });

  textarea.addEventListener('input', () => {
    hideCompletion();
    refreshStatus();
    updatePosition();
    schedule();
    scheduleCompletion();
  });

  textarea.addEventListener('scroll', syncScroll, { passive: true });
  textarea.addEventListener('click', () => {
    hideCompletion();
    updatePosition();
  });
  textarea.addEventListener('blur', hideCompletion);
  textarea.addEventListener('keyup', updatePosition);

  textarea.addEventListener('keydown', (event) => {
    const mod = event.metaKey || event.ctrlKey;

    if (completionOpen()) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const step = event.key === 'ArrowDown' ? 1 : -1;
        const count = completionItems.length;
        if (count) highlightCompletion((completionIndex + step + count) % count);
        return;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        acceptCompletion();
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        hideCompletion();
        return;
      }
    }

    if (mod && event.key.toLowerCase() === 's') {
      event.preventDefault();
      save();
      return;
    }

    if (mod && event.key === ' ') {
      event.preventDefault();
      requestCompletion(true);
      return;
    }

    if (event.key === 'Tab' && !event.shiftKey && !readOnly) {
      event.preventDefault();
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      textarea.setRangeText('  ', start, end, 'end');
      refreshStatus();
      updatePosition();
      schedule();
    }
  });

  window.addEventListener('resize', () => {
    syncScroll();
    if (completionOpen()) positionCompletion();
  });

  window.addEventListener('beforeunload', (event) => {
    if (!dirty()) return;
    event.preventDefault();
    event.returnValue = '';
  });

  renderHighlight();
  refreshStatus();
  updatePosition();
})();
