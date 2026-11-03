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
      return value === 'light' || value === 'dark' ? value : '';
    } catch {
      return '';
    }
  }

  function applyTheme(theme, remember) {
    root.dataset.theme = theme === 'light' ? 'light' : 'dark';
    if (remember) {
      try {
        localStorage.setItem(STORAGE_KEY, root.dataset.theme);
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

  // The inline <head> script already chose; this only syncs the button.
  applyTheme(root.dataset.theme === 'light' ? 'light' : 'dark', false);

  if (themeButton) {
    themeButton.addEventListener('click', () => {
      applyTheme(root.dataset.theme === 'light' ? 'dark' : 'light', true);
    });
  }

  if (themeMedia && themeMedia.addEventListener) {
    themeMedia.addEventListener('change', (event) => {
      // An explicit choice wins over the system; otherwise follow the system.
      if (!storedTheme()) applyTheme(event.matches ? 'light' : 'dark', false);
    });
  }

  /* ---- editor --------------------------------------------------------- */

  const textarea = document.getElementById('editor');
  const highlight = document.getElementById('highlight');
  const statusEl = document.getElementById('status');
  const positionEl = document.getElementById('position');
  const fallback = document.getElementById('fallback');

  if (!textarea || !highlight) return;

  const path = body.dataset.path || '';
  const folder = body.dataset.dir || '';
  const language = body.dataset.language || 'plaintext';
  const readOnly = body.dataset.readOnly === 'true';
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
    } catch {
      setStatus('save failed', 'warn');
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

  /* ---- open file (quick open) ------------------------------------------ */

  const quickDialog = document.getElementById('quick-open');
  const quickInput = document.getElementById('quick-input');
  const quickResults = document.getElementById('quick-results');

  let quickItems = [];
  let quickIndex = 0;
  let quickTimer = 0;
  let quickToken = 0;

  function goToFile(relative) {
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
