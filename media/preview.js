/* global acquireVsCodeApi */
(() => {
  'use strict';
  const vscode = acquireVsCodeApi();
  const content = document.getElementById('content');
  const pill = document.getElementById('back-to-reading');
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '');
  const highlights = typeof CSS !== 'undefined' && CSS.highlights && typeof Highlight === 'function' ? CSS.highlights : null;

  /** Rendered words in document order, with their source positions. */
  let words = [];
  /** The reading position: source ranges of the sentence and the word being spoken. */
  let position = null;
  let settings = { follow: true, words: true };
  /** False once the listener scrolls the reading out of view, until it is back in view. */
  let following = true;
  let marked = { words: [], sentence: [], blocks: [] };
  /** The text of the sentence, when it is highlighted as a run of text rather than a block. */
  let sentenceRange = null;
  let target = [];
  let ownScroll = false;
  let ownScrollTimer = 0;
  let reported = '';

  const post = message => vscode.postMessage(message);
  const before = (line, character, otherLine, otherCharacter) => line < otherLine || (line === otherLine && character < otherCharacter);
  const inside = (word, range) => !before(word.line, word.character, range.line, range.character) && before(word.line, word.character, range.endLine, range.endCharacter);
  const parse = element => {
    const [line, character] = element.dataset.p.split(',').map(Number);
    return { element, line, character };
  };

  function index() {
    words = [...content.querySelectorAll('.w[data-p]')].map(parse);
  }

  function clearMarks() {
    highlights?.delete('cmr-sentence');
    for (const element of marked.words) element.classList.remove('cmr-word');
    for (const element of marked.sentence) element.classList.remove('cmr-sentence');
    for (const element of marked.blocks) element.classList.remove('cmr-block');
    marked = { words: [], sentence: [], blocks: [] };
    sentenceRange = null;
    target = [];
  }

  /** Blocks (paragraphs, code, tables) whose first line is within a range, outermost first. */
  function blocksIn(range) {
    const found = [...content.querySelectorAll('[data-line]')].filter(element => {
      const line = Number(element.dataset.line);
      return line >= range.line && line <= range.endLine;
    });
    return found.filter(element => !found.some(other => other !== element && other.contains(element))).map(element => element.closest('pre') || element);
  }

  function mark() {
    clearMarks();
    if (!position || !position.sentence) return;
    const { sentence, word } = position;
    const spoken = words.filter(entry => inside(entry, sentence));
    const rows = new Set(spoken.map(entry => entry.element.closest('tr')));
    // The one table row holding every spoken word, if the sentence is a row.
    const row = rows.size === 1 ? [...rows][0] : null;
    if (spoken.length && !row) {
      const first = spoken[0].element;
      const last = spoken[spoken.length - 1].element;
      sentenceRange = document.createRange();
      sentenceRange.setStartBefore(first);
      sentenceRange.setEndAfter(last);
      if (highlights) highlights.set('cmr-sentence', new Highlight(sentenceRange));
      else {
        for (const entry of spoken) entry.element.classList.add('cmr-sentence');
        marked.sentence = spoken.map(entry => entry.element);
      }
      target = [first, last];
    } else {
      // A table row, a code block or a block read from a Copilot description: highlight the block itself.
      const blocks = row ? [row] : blocksIn(sentence);
      for (const element of blocks) element.classList.add('cmr-block');
      marked.blocks = blocks;
      target = blocks;
    }
    if (word && settings.words) {
      marked.words = words.filter(entry => inside(entry, word)).map(entry => entry.element);
      for (const element of marked.words) element.classList.add('cmr-word');
    }
  }

  function bounds() {
    let top = Infinity;
    let bottom = -Infinity;
    for (const element of target) {
      const rect = element.getBoundingClientRect();
      if (!rect.width && !rect.height) continue;
      top = Math.min(top, rect.top);
      bottom = Math.max(bottom, rect.bottom);
    }
    return top === Infinity ? null : { top, bottom };
  }

  function scrollToReading(force) {
    const rect = bounds();
    if (!rect) return;
    const height = window.innerHeight;
    if (!force && rect.top >= height * 0.1 && rect.bottom <= height * 0.8) return;
    ownScroll = true;
    clearTimeout(ownScrollTimer);
    ownScrollTimer = setTimeout(() => { ownScroll = false; }, 1500);
    window.scrollTo({ top: Math.max(0, window.scrollY + rect.top - height * 0.3), behavior: reduceMotion || force === 'instant' ? 'auto' : 'smooth' });
  }

  function updatePill() {
    const rect = position && bounds();
    if (!rect || following || !settings.follow) {
      pill.hidden = true;
      return;
    }
    pill.textContent = rect.top < 0 ? '↑ Back to reading' : '↓ Back to reading';
    pill.hidden = false;
  }

  /** Tells the extension what is highlighted; used by the integration test and diagnostics. */
  function report() {
    const clean = text => text.replace(/\s+/g, ' ').trim();
    const sentence = sentenceRange ? sentenceRange.toString() : target.map(element => element.textContent).join(' ');
    const state = { type: 'state', sentence: clean(sentence), word: clean(marked.words.map(element => element.textContent).join('')), following };
    const key = JSON.stringify(state);
    if (key === reported) return;
    reported = key;
    post(state);
  }

  function show(next, scroll) {
    const moved = !position || !next || JSON.stringify(position.sentence) !== JSON.stringify(next.sentence);
    position = next;
    mark();
    if (scroll && moved && following && settings.follow) scrollToReading(false);
    updatePill();
    report();
  }

  /** Re-renders after an edit, keeping the same part of the document in view. */
  function render(html) {
    let anchor = null;
    for (const element of content.querySelectorAll('[data-line]')) {
      if (element.getBoundingClientRect().bottom > 0) {
        anchor = { line: element.dataset.line, offset: element.getBoundingClientRect().top };
        break;
      }
    }
    content.innerHTML = html;
    index();
    if (anchor) {
      const element = content.querySelector(`[data-line="${anchor.line}"]`);
      if (element) window.scrollBy(0, element.getBoundingClientRect().top - anchor.offset);
    }
    show(position, false);
  }

  window.addEventListener('scroll', () => {
    if (ownScroll || !position) return;
    const rect = bounds();
    const visible = rect && rect.bottom > 0 && rect.top < window.innerHeight;
    if (visible !== following) {
      following = !!visible;
      updatePill();
      report();
    }
  }, { passive: true });
  window.addEventListener('scrollend', () => {
    if (!ownScroll) return;
    clearTimeout(ownScrollTimer);
    ownScroll = false;
  });

  pill.addEventListener('click', () => {
    following = true;
    scrollToReading(true);
    updatePill();
    report();
  });

  const positionAt = node => {
    const element = node instanceof Element ? node : node?.parentElement;
    const word = element?.closest('.w[data-p]');
    if (word) return parse(word);
    // Code blocks carry their line on the inner <code>, so look inside a clicked <pre> too.
    const block = element?.closest('[data-line]') || element?.closest('pre')?.querySelector('[data-line]');
    return block ? { line: Number(block.dataset.line), character: 0 } : null;
  };

  // Double-click a word to read from it; right-click offers Read Aloud from Here.
  content.addEventListener('dblclick', event => {
    const at = positionAt(event.target);
    if (!at || event.target.closest('a')) return;
    window.getSelection()?.removeAllRanges();
    following = true;
    post({ type: 'readFrom', line: at.line, character: at.character });
  });
  content.addEventListener('contextmenu', event => {
    const at = positionAt(event.target);
    if (at) post({ type: 'contextTarget', line: at.line, character: at.character });
  });

  content.addEventListener('click', event => {
    const link = event.target instanceof Element ? event.target.closest('a[href]') : null;
    if (!link) return;
    event.preventDefault();
    const href = link.getAttribute('href');
    if (href.startsWith('#')) {
      const id = decodeURIComponent(href.slice(1));
      const heading = document.getElementById(id) || document.getElementById(id.toLowerCase());
      heading?.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
      return;
    }
    post({ type: 'openLink', href });
  });

  // While this file is being read, the player's keys work here too. ↑ / ↓, Space and Page Up / Down
  // keep scrolling the page, as in any preview.
  document.addEventListener('keydown', keyEvent => {
    if (!position || keyEvent.defaultPrevented || keyEvent.metaKey) return;
    // Alt+← is Go Back in VS Code on Windows and Linux, so the seconds skip uses Ctrl (Option on macOS).
    const jump = keyEvent.ctrlKey || (IS_MAC && keyEvent.altKey);
    if ((keyEvent.ctrlKey || keyEvent.altKey) && !jump) return;
    const shift = keyEvent.shiftKey;
    const actions = jump ? { ArrowLeft: 'skipBack', ArrowRight: 'skipForward' } : {
      ArrowLeft: shift ? 'previousSentence' : 'previousParagraph',
      ArrowRight: shift ? 'nextSentence' : 'nextParagraph',
      ArrowUp: shift ? 'previousSection' : undefined,
      ArrowDown: shift ? 'nextSection' : undefined,
      k: 'togglePlay', K: 'togglePlay', j: 'skipBack', J: 'skipBack', l: 'skipForward', L: 'skipForward',
      ',': 'previousSentence', '.': 'nextSentence', '[': 'previousParagraph', ']': 'nextParagraph',
      '-': 'slower', _: 'slower', '=': 'faster', '+': 'faster'
    };
    const action = actions[keyEvent.key];
    if (!action) return;
    keyEvent.preventDefault();
    following = true;
    post({ type: 'command', action });
  });

  window.addEventListener('message', ({ data }) => {
    switch (data.type) {
      case 'render': render(data.html); break;
      case 'position': show(data.position, true); break;
      case 'clear': show(null, false); break;
      case 'settings':
        settings = { ...settings, ...data.settings };
        if (!settings.follow) following = true;
        show(position, false);
        break;
      case 'reveal':
        following = true;
        scrollToReading(true);
        updatePill();
        break;
    }
  });

  index();
  post({ type: 'ready' });
})();
