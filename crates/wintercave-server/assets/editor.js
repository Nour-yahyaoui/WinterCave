/*
 * WinterCave — the thin client.
 *
 * All of the editor's logic lives in Rust: this file only carries text between
 * the page, the highlight endpoint and the file API. It is plain JavaScript on
 * purpose — no framework, no bundler, no build step — and the page still works
 * without it through the <form> fallback.
 */
(() => {
  'use strict';

  const body = document.body;
  const textarea = document.getElementById('editor');
  const highlight = document.getElementById('highlight');
  const statusEl = document.getElementById('status');
  const positionEl = document.getElementById('position');
  const fallback = document.getElementById('fallback');

  if (!textarea || !highlight) return;

  const path = body.dataset.path || '';
  const language = body.dataset.language || 'plaintext';
  const readOnly = body.dataset.readOnly === 'true';
  const MAX_HIGHLIGHT = 400000;

  // The script is alive: the no-JavaScript save button is not needed any more.
  if (fallback) fallback.hidden = true;

  let saved = textarea.value;
  let timer = 0;
  let generation = 0;

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
    setStatus('saving…', 'dirty');
    try {
      const response = await fetch('/api/files?path=' + encodeURIComponent(path), {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: textarea.value }),
      });
      if (!response.ok) {
        const problem = await response.json().catch(() => ({}));
        setStatus((problem.error && problem.error.message) || 'save failed', 'warn');
        return;
      }
      saved = textarea.value;
      refreshStatus();
    } catch {
      setStatus('save failed', 'warn');
    }
  }

  textarea.addEventListener('input', () => {
    refreshStatus();
    updatePosition();
    schedule();
  });
  textarea.addEventListener('scroll', syncScroll, { passive: true });
  textarea.addEventListener('click', updatePosition);
  textarea.addEventListener('keyup', updatePosition);
  textarea.addEventListener('keydown', (event) => {
    const mod = event.metaKey || event.ctrlKey;
    if (mod && event.key.toLowerCase() === 's') {
      event.preventDefault();
      save();
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

  window.addEventListener('resize', syncScroll);
  window.addEventListener('beforeunload', (event) => {
    if (!dirty()) return;
    event.preventDefault();
    event.returnValue = '';
  });

  renderHighlight();
  refreshStatus();
  updatePosition();
})();
