/* global acquireVsCodeApi */
(() => {
  'use strict';
  const vscode = acquireVsCodeApi();
  const $ = id => document.getElementById(id);
  const SPEEDS = [0.5, 0.6, 0.7, 0.75, 0.8, 0.9, 1, 1.1, 1.2, 1.25, 1.3, 1.4, 1.5, 1.6, 1.75, 1.9, 2, 2.25, 2.5, 2.75, 3];
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const audio = new Audio();
  audio.preload = 'auto';
  audio.preservesPitch = true;
  // VS Code webviews only allow sound after a click or key press inside the webview. One silent play
  // during the first gesture unlocks this element for the rest of the panel's life.
  const SILENT = URL.createObjectURL(new Blob([silentWav()], { type: 'audio/wav' }));
  let unlocked = false;
  const ICON_PLAY = $('play').innerHTML;
  const ICON_PAUSE = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M7 5h4v14H7zm6 0h4v14h-4z"/></svg>';

  let revision = -1;
  let utterances = [];
  let blocks = [];
  let settings = { skipBack: 10, skipForward: 30, highlightWords: true, followInEditor: true };
  let engine = { state: 'loading', voices: [], voice: '' };
  const cache = new Map();
  let cachedBytes = 0;
  let spokenChars = 0;
  let spokenSeconds = 0;
  let cps = 14.5;
  let prefix = [0];
  let index = 0;
  let playing = false;
  let loaded = -1;
  let pendingOffset = 0;
  let pendingWord = null;
  let rate = 1;
  let follow = true;
  let autoplay = false;
  let finished = false;
  let stale = false;
  let wordIndex = new Map();
  let elementIndex = new Map();
  let highlighted = [];
  let wordElements = [];
  let currentWord = -1;
  let lastNeed = '';
  let scrubbing = false;
  let programmaticUntil = 0;
  let playToken = 0;
  let lastReport = 0;
  let reportedIndex = -1;
  let reportedPlaying = null;
  let rateTimer;
  let error = '';
  const reported = new Set();

  const post = message => vscode.postMessage(message);

  function silentWav() {
    const samples = 400;
    const view = new DataView(new ArrayBuffer(44 + samples * 2));
    const text = (offset, value) => [...value].forEach((ch, i) => view.setUint8(offset + i, ch.charCodeAt(0)));
    text(0, 'RIFF');
    view.setUint32(4, 36 + samples * 2, true);
    text(8, 'WAVEfmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, 8000, true);
    view.setUint32(28, 16000, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    text(36, 'data');
    view.setUint32(40, samples * 2, true);
    return view.buffer;
  }
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const event = name => {
    if (reported.has(name)) return;
    reported.add(name);
    post({ type: 'event', event: name });
  };
  const describeError = failure => (failure && typeof failure === 'object' ? `${failure.name || 'Error'}: ${failure.message || ''}` : String(failure));
  const clock = seconds => {
    const s = Math.max(0, Math.round(seconds));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const rest = String(s % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${rest}` : `${m}:${rest}`;
  };
  const formatRate = value => `${Number(value.toFixed(2))}×`;

  function duration(i) {
    const entry = cache.get(i);
    if (entry) return entry.duration;
    const u = utterances[i];
    return u ? u.c / cps + u.p : 0;
  }

  function rebuildTimeline() {
    prefix = new Array(utterances.length + 1);
    prefix[0] = 0;
    for (let i = 0; i < utterances.length; i++) prefix[i + 1] = prefix[i] + duration(i);
    renderChapters();
  }

  const total = () => prefix[utterances.length] || 0;
  const now = () => (prefix[index] || 0) + (loaded === index ? audio.currentTime || 0 : pendingOffset);

  function locate(time) {
    let low = 0;
    let high = Math.max(0, utterances.length - 1);
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (prefix[middle] <= time) low = middle;
      else high = middle - 1;
    }
    return low;
  }

  function setStatus(text) {
    if ($('status').textContent !== text) $('status').textContent = text;
  }

  function updateControls() {
    if (navigator.mediaSession) navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
    const ready = engine.state === 'ready' && utterances.length > 0;
    const waiting = playing && loaded !== index;
    const play = $('play');
    play.innerHTML = playing ? ICON_PAUSE : ICON_PLAY;
    play.title = playing ? 'Pause (Space)' : 'Play (Space)';
    play.setAttribute('aria-label', playing ? 'Pause' : 'Play');
    play.classList.toggle('waiting', waiting);
    for (const id of ['play', 'back', 'forward', 'previous', 'next', 'seek']) $(id).disabled = !ready;
    if (error) setStatus(error);
    else if (!ready) setStatus(engine.state === 'loading' ? (engine.message || 'Starting the voice…') : '');
    else if (waiting) setStatus('Preparing audio…');
    else if (finished) setStatus('Finished. Press Play to listen again.');
    else setStatus(playing ? '' : 'Paused');
  }

  function updateTime() {
    const elapsed = now();
    const length = total();
    const estimated = utterances.some((_, i) => i >= index && !cache.has(i));
    if (!scrubbing) {
      $('seek').max = String(Math.max(1, length));
      $('seek').value = String(elapsed);
      $('elapsed').textContent = clock(elapsed);
    }
    $('remaining').textContent = `${estimated ? '~' : ''}${clock((length - elapsed) / rate)} left`;
    $('remaining').title = estimated ? 'Estimated time left at this speed; it becomes exact as audio is prepared' : 'Time left at this speed';
    $('seek').setAttribute('aria-valuetext', `${clock(elapsed)} of ${clock(length)}`);
    report();
  }

  function report(force) {
    const time = performance.now();
    if (!force && index === reportedIndex && playing === reportedPlaying && time - lastReport < 1000) return;
    lastReport = time;
    reportedIndex = index;
    reportedPlaying = playing;
    post({ type: 'position', index, playing, elapsed: now(), total: total() });
  }

  function clearWord() {
    for (const element of wordElements) element.classList.remove('reading-word');
    wordElements = [];
    currentWord = -1;
  }

  function highlight(i) {
    for (const element of highlighted) element.classList.remove('reading');
    highlighted = [];
    clearWord();
    const u = utterances[i];
    if (!u) return;
    for (const id of u.h) {
      const element = document.getElementById(id);
      if (element) {
        element.classList.add('reading');
        highlighted.push(element);
      }
    }
    if (follow) scrollToCurrent(false);
    else updatePill();
  }

  function updateWord() {
    if (!settings.highlightWords || loaded !== index) return;
    const entry = cache.get(index);
    const u = utterances[index];
    if (!entry || !u) return;
    const time = audio.currentTime + 0.03;
    let k = -1;
    for (let j = 0; j < u.w.length; j++) {
      const start = entry.times[2 * j];
      if (start < 0) continue;
      if (start <= time) k = j;
      else break;
    }
    if (k === currentWord) return;
    clearWord();
    currentWord = k;
    const id = k >= 0 ? u.w[k] : null;
    const element = id && document.getElementById(id);
    if (element) {
      element.classList.add('reading-word');
      wordElements.push(element);
    }
  }

  function tick() {
    if (!playing) return;
    updateWord();
    if (!scrubbing) updateTime();
    requestAnimationFrame(tick);
  }

  function currentRect() {
    let top = Infinity;
    let bottom = -Infinity;
    for (const element of highlighted) {
      const rect = element.getBoundingClientRect();
      if (!rect.width && !rect.height) continue;
      top = Math.min(top, rect.top);
      bottom = Math.max(bottom, rect.bottom);
    }
    return top === Infinity ? null : { top, bottom };
  }

  const viewport = () => window.innerHeight - $('player').getBoundingClientRect().height;

  function scrollToCurrent(force) {
    const rect = currentRect();
    if (!rect) return;
    const height = viewport();
    if (!force && rect.top >= height * 0.12 && rect.bottom <= height * 0.72) return;
    programmaticUntil = performance.now() + (reduceMotion ? 200 : 1200);
    window.scrollTo({ top: Math.max(0, window.scrollY + rect.top - height * 0.3), behavior: reduceMotion ? 'auto' : 'smooth' });
    $('back-to-reading').hidden = true;
  }

  function updatePill() {
    const pill = $('back-to-reading');
    const rect = currentRect();
    if (!rect || follow) {
      pill.hidden = true;
      return;
    }
    if (rect.bottom > 0 && rect.top < viewport()) {
      // The reading position is back in view, so resume following it.
      follow = true;
      pill.hidden = true;
      return;
    }
    pill.textContent = rect.top < 0 ? '↑ Back to reading' : '↓ Back to reading';
    pill.hidden = false;
  }

  function evict() {
    if (cachedBytes < 160 * 1024 * 1024) return;
    for (const [i, entry] of cache) {
      if (Math.abs(i - index) < 60 || cachedBytes < 120 * 1024 * 1024) continue;
      URL.revokeObjectURL(entry.url);
      cachedBytes -= entry.bytes;
      cache.delete(i);
    }
  }

  function resetAudio() {
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
    for (const entry of cache.values()) URL.revokeObjectURL(entry.url);
    cache.clear();
    cachedBytes = 0;
    loaded = -1;
    lastNeed = '';
    playToken++;
  }

  function requestNeeded() {
    if (engine.state !== 'ready' || !utterances.length) return;
    const wanted = [];
    let ahead = 0;
    for (let i = index; i < utterances.length && wanted.length < 40 && ahead < 150; i++) {
      if (!cache.has(i)) wanted.push(i);
      ahead += duration(i);
    }
    const key = `${revision}:${wanted.join(',')}`;
    if (key === lastNeed) return;
    lastNeed = key;
    if (wanted.length) post({ type: 'need', revision, indices: wanted });
  }

  async function startPlayback() {
    const token = ++playToken;
    try {
      await audio.play();
      $('start').hidden = true;
      if (token === playToken) event('playing');
    } catch (failure) {
      if (token !== playToken || !playing) return;
      playing = false;
      error = '';
      updateControls();
      if (failure && failure.name === 'NotAllowedError') needGesture();
      else {
        event(`play-error ${describeError(failure)}`);
        setStatus('Press Play to start listening.');
      }
    }
  }

  function load(i, offset) {
    const entry = cache.get(i);
    if (!entry) return;
    if (loaded !== i) {
      audio.src = entry.url;
      loaded = i;
    }
    audio.defaultPlaybackRate = rate;
    audio.playbackRate = rate;
    try {
      audio.currentTime = clamp(offset, 0, Math.max(0, entry.duration - 0.05));
    } catch {
      // Some engines reject seeking before metadata loads; playback then starts at the beginning.
    }
    currentWord = -1;
    if (playing) {
      void startPlayback();
      requestAnimationFrame(tick);
    }
  }

  function go(i, offset = 0, play = playing) {
    if (!utterances.length) return;
    i = clamp(i, 0, utterances.length - 1);
    error = '';
    finished = false;
    playing = play && engine.state === 'ready';
    if (i !== index || !highlighted.length) {
      index = i;
      highlight(i);
    }
    pendingOffset = Math.max(0, offset);
    clearWord();
    requestNeeded();
    if (cache.has(i)) load(i, pendingOffset);
    else {
      playToken++;
      audio.pause();
      loaded = -1;
    }
    updateControls();
    updateTime();
    report(true);
  }

  function play() {
    if (!utterances.length || engine.state !== 'ready') return;
    if (finished) return go(0, 0, true);
    playing = true;
    error = '';
    if (loaded === index) {
      void startPlayback();
      requestAnimationFrame(tick);
    } else go(index, pendingOffset, true);
    updateControls();
    report(true);
  }

  function pause() {
    playing = false;
    playToken++;
    audio.pause();
    if (loaded === index) pendingOffset = audio.currentTime;
    updateControls();
    updateTime();
    report(true);
  }

  const toggle = () => (playing ? pause() : play());

  function seekTo(time) {
    const target = clamp(time, 0, Math.max(0, total() - 0.05));
    const i = locate(target);
    go(i, target - prefix[i]);
  }

  function sentence(step) {
    if (step < 0 && loaded === index && audio.currentTime > 1.5) return go(index, 0);
    go(index + step, 0);
  }

  function paragraph(step) {
    const block = utterances[index]?.b;
    if (step > 0) {
      const next = utterances.findIndex((u, i) => i > index && u.b !== block);
      if (next >= 0) go(next, 0);
      return;
    }
    let start = index;
    while (start > 0 && utterances[start - 1].b === block) start--;
    const insideBlock = start < index || (loaded === index && audio.currentTime > 1.5);
    if (!insideBlock && start > 0) {
      const previous = utterances[--start].b;
      while (start > 0 && utterances[start - 1].b === previous) start--;
    }
    go(start, 0);
  }

  function setRate(value, persist = true) {
    rate = clamp(Number(value) || 1, 0.5, 3);
    audio.defaultPlaybackRate = rate;
    audio.playbackRate = rate;
    $('rate').textContent = formatRate(rate);
    for (const button of $('speed-menu').querySelectorAll('button')) button.setAttribute('aria-checked', String(Number(button.dataset.rate) === rate));
    updateTime();
    if (!persist) return;
    clearTimeout(rateTimer);
    rateTimer = setTimeout(() => post({ type: 'setting', key: 'rate', value: rate }), 400);
  }

  function stepRate(step) {
    const position = SPEEDS.findIndex(value => value >= rate - 0.001);
    const current = position < 0 ? SPEEDS.length - 1 : position;
    setRate(SPEEDS[clamp(current + step, 0, SPEEDS.length - 1)]);
  }

  function renderChapters() {
    const container = $('chapters');
    const length = total();
    container.replaceChildren(...blocks.filter(block => block.k === 'heading' && block.f >= 0 && block.l <= 3).map(block => {
      const tick = document.createElement('button');
      tick.className = 'chapter';
      tick.style.left = `${length ? (prefix[block.f] / length) * 100 : 0}%`;
      tick.title = block.t;
      tick.setAttribute('aria-label', `Go to ${block.t}`);
      tick.tabIndex = -1;
      tick.addEventListener('click', () => go(block.f, 0));
      return tick;
    }));
  }

  function renderVoices() {
    const select = $('voice');
    const options = (engine.voices || []).map(voice => new Option(voice.label, voice.id));
    if (engine.kind === 'system') options.unshift(new Option('System default voice', ''));
    select.replaceChildren(...options);
    select.value = engine.voice || '';
    select.disabled = engine.state !== 'ready';
    $('engine-switch').textContent = engine.kind === 'system' ? 'Use the natural voice' : 'Use the system voice instead';
  }

  function button(label, action, primary) {
    const element = document.createElement('button');
    element.textContent = label;
    if (primary) element.className = 'primary-button';
    element.addEventListener('click', action);
    return element;
  }

  function renderBanner() {
    const banner = $('banner');
    const parts = [];
    if (engine.state === 'missing') {
      const text = document.createElement('p');
      text.innerHTML = '<strong>Install the natural voice to start.</strong> ';
      text.append(`It is a one-time ${engine.sizeMB} MB download, and it then runs entirely on this computer.`);
      parts.push(text);
      if (engine.message) {
        const detail = document.createElement('p');
        detail.className = 'detail';
        detail.textContent = engine.message;
        parts.push(detail);
      }
      parts.push(button(`Download natural voice (${engine.sizeMB} MB)`, () => post({ type: 'install' }), true),
        button('Use system voice', () => post({ type: 'useSystem' })));
    } else if (engine.state === 'downloading') {
      const text = document.createElement('p');
      text.textContent = `Downloading the natural voice… ${engine.progress}%`;
      const bar = document.createElement('progress');
      bar.max = 100;
      bar.value = engine.progress;
      parts.push(text, bar, button('Cancel', () => post({ type: 'cancelInstall' })));
    } else if (engine.state === 'error') {
      const text = document.createElement('p');
      text.textContent = engine.message || 'The voice could not start.';
      parts.push(text, button('Try again', () => post({ type: 'retry' }), true),
        engine.kind === 'system' ? button('Use natural voice', () => post({ type: 'useNatural' })) : button('Use system voice', () => post({ type: 'useSystem' })));
    }
    if (stale) {
      const text = document.createElement('p');
      text.textContent = 'This document changed after the reader opened.';
      parts.push(text, button(settings.selection ? 'Reopen to read the new selection' : 'Refresh', () => {
        if (settings.selection) return;
        stale = false;
        post({ type: 'refresh' });
        renderBanner();
      }));
    }
    banner.replaceChildren(...parts);
    banner.hidden = !parts.length;
    banner.className = `banner ${engine.state === 'error' ? 'error' : ''}`;
  }

  function decorateBlocks() {
    blocks.forEach((block, i) => {
      if (block.k !== 'table' && block.k !== 'code') return;
      const element = document.getElementById(block.id);
      if (!element) return;
      const anchor = element.closest('.table-wrap') || element;
      const tools = document.createElement('div');
      tools.className = 'block-tools';
      if (block.ai) {
        tools.append('Narrated from a Copilot description. ');
        tools.append(button('Use the original narration', () => post({ type: 'restore', block: i })));
      } else {
        const describe = button(block.k === 'table' ? 'Describe table with Copilot' : 'Explain code with Copilot', () => {
          describe.disabled = true;
          describe.textContent = 'Asking Copilot…';
          post({ type: 'describe', block: i });
        });
        describe.className = 'describe';
        describe.dataset.block = String(i);
        tools.append(describe);
      }
      anchor.before(tools);
    });
  }

  function showDescription(message) {
    const block = blocks[message.block];
    const element = block && document.getElementById(block.id);
    if (!element) return;
    const anchor = element.closest('.table-wrap') || element;
    anchor.parentElement.querySelector(`.describe-box[data-block="${message.block}"]`)?.remove();
    const describe = document.querySelector(`.describe[data-block="${message.block}"]`);
    if (describe) {
      describe.disabled = false;
      describe.textContent = block.k === 'table' ? 'Describe table with Copilot' : 'Explain code with Copilot';
    }
    if (!message.text && !message.error) return;
    const box = document.createElement('div');
    box.className = 'describe-box';
    box.dataset.block = String(message.block);
    const label = document.createElement('p');
    label.className = 'describe-label';
    label.textContent = message.error ? 'Copilot could not describe this block.' : 'Copilot description. Check it against the original before using it; AI can make mistakes.';
    const text = document.createElement('p');
    text.textContent = message.error || message.text;
    box.append(label, text);
    if (message.text) box.append(button('Read this instead', () => post({ type: 'useDescription', block: message.block, text: message.text }), true));
    box.append(button(message.text ? 'Discard' : 'Close', () => box.remove()));
    anchor.after(box);
  }

  function buildIndexes() {
    wordIndex = new Map();
    elementIndex = new Map();
    utterances.forEach((u, i) => {
      u.w.forEach((id, k) => {
        if (id && !wordIndex.has(id)) wordIndex.set(id, [i, k]);
      });
      for (const id of u.h) if (!elementIndex.has(id)) elementIndex.set(id, i);
    });
    blocks.forEach(block => {
      if (block.f >= 0 && !elementIndex.has(block.id)) elementIndex.set(block.id, block.f);
    });
  }

  function onPlan(message) {
    reported.clear();
    resetAudio();
    revision = message.revision;
    utterances = message.utterances;
    blocks = message.blocks;
    settings = message.settings;
    spokenChars = 0;
    spokenSeconds = 0;
    $('doc').innerHTML = message.html;
    decorateBlocks();
    buildIndexes();
    setRate(settings.rate, false);
    $('table-mode').value = settings.tableMode;
    $('code-blocks').value = settings.codeBlocks;
    $('words').checked = settings.highlightWords;
    $('editor-follow').checked = settings.followInEditor;
    $('follow').checked = true;
    highlighted = [];
    if (navigator.mediaSession && typeof MediaMetadata === 'function') {
      navigator.mediaSession.metadata = new MediaMetadata({ title: settings.title || 'Markdown', artist: 'Clear Markdown Reader' });
    }
    index = clamp(message.start.index, 0, Math.max(0, utterances.length - 1));
    pendingOffset = message.start.offset || 0;
    autoplay = !!message.start.autoplay;
    playing = false;
    finished = false;
    follow = true;
    rebuildTimeline();
    highlight(index);
    scrollToCurrent(true);
    renderBanner();
    updateControls();
    updateTime();
  }

  function onEngine(message) {
    if (message.revision !== revision) {
      resetAudio();
      revision = message.revision;
      spokenChars = 0;
      spokenSeconds = 0;
      if (loaded !== index) pendingOffset = 0;
    }
    engine = message;
    renderVoices();
    renderBanner();
    if (engine.state === 'ready') {
      error = '';
      rebuildTimeline();
      if (autoplay || playing) {
        autoplay = false;
        go(index, pendingOffset, true);
      } else requestNeeded();
    } else if (engine.state !== 'loading') {
      if (playing) pause();
    }
    updateControls();
    updateTime();
  }

  function onAudio(message) {
    if (message.revision !== revision || !utterances[message.index]) return;
    const old = cache.get(message.index);
    if (old) {
      URL.revokeObjectURL(old.url);
      cachedBytes -= old.bytes;
    }
    const url = URL.createObjectURL(new Blob([message.wav], { type: 'audio/wav' }));
    cache.set(message.index, { url, duration: message.duration, times: message.wordTimes, bytes: message.wav.byteLength });
    cachedBytes += message.wav.byteLength;
    event('audio');
    event(`wav ${Object.prototype.toString.call(message.wav)} ${message.wav && message.wav.byteLength}`);
    const u = utterances[message.index];
    const speech = message.duration - u.p;
    if (!old && speech > 0.4 && u.c > 8) {
      spokenChars += u.c;
      spokenSeconds += speech;
      cps = clamp(spokenChars / spokenSeconds, 8, 25);
    }
    rebuildTimeline();
    if (message.index === index && loaded !== index) {
      if (pendingWord && pendingWord.index === index) {
        const start = message.wordTimes[2 * pendingWord.word];
        if (start >= 0) pendingOffset = Math.max(0, start - 0.05);
      }
      pendingWord = null;
      load(index, pendingOffset);
      updateControls();
    }
    evict();
    requestNeeded();
    updateTime();
  }

  audio.addEventListener('ended', () => {
    if (!playing || loaded < 0) return;
    if (index + 1 < utterances.length) go(index + 1, 0, true);
    else {
      playing = false;
      finished = true;
      clearWord();
      updateControls();
      report(true);
      event('finished');
    }
  });
  audio.addEventListener('error', () => {
    if (!audio.getAttribute('src')) return;
    event(`audio-error ${audio.error ? `${audio.error.code} ${audio.error.message}` : 'unknown'}`);
    if (!playing) return;
    pause();
    error = 'This passage could not be played. Press Play to try again.';
    cache.delete(loaded);
    loaded = -1;
    updateControls();
  });

  function unlock() {
    if (unlocked) return;
    unlocked = true;
    if (loaded >= 0 && !audio.paused) return;
    if (loaded === index) pendingOffset = audio.currentTime || pendingOffset;
    loaded = -1;
    audio.src = SILENT;
    audio.play().then(() => {
      if (audio.getAttribute('src') === SILENT) audio.pause();
      event('unlocked');
    }, failure => {
      // A newer load interrupting this play still leaves the element unlocked.
      if (failure && failure.name === 'NotAllowedError') unlocked = false;
    });
  }

  function needGesture() {
    unlocked = false;
    $('start').hidden = false;
    $('start-button').focus();
    event('needs-gesture');
  }

  document.addEventListener('pointerdown', unlock, true);
  document.addEventListener('keydown', keyEvent => {
    if (!keyEvent.repeat && !['Escape', 'Tab', 'Shift', 'Control', 'Alt', 'Meta'].includes(keyEvent.key)) unlock();
  }, true);
  $('start-button').addEventListener('click', () => {
    $('start').hidden = true;
    play();
  });

  // Player controls.
  $('play').addEventListener('click', toggle);
  $('back').addEventListener('click', () => seekTo(now() - settings.skipBack));
  $('forward').addEventListener('click', () => seekTo(now() + settings.skipForward));
  $('previous').addEventListener('click', () => sentence(-1));
  $('next').addEventListener('click', () => sentence(1));
  $('seek').addEventListener('input', () => {
    scrubbing = true;
    $('elapsed').textContent = clock(Number($('seek').value));
  });
  $('seek').addEventListener('change', () => {
    scrubbing = false;
    seekTo(Number($('seek').value));
  });
  $('back-to-reading').addEventListener('click', () => {
    follow = true;
    scrollToCurrent(true);
  });

  const speedMenu = $('speed-menu');
  speedMenu.replaceChildren(...SPEEDS.map(value => {
    const item = document.createElement('button');
    item.textContent = formatRate(value);
    item.dataset.rate = String(value);
    item.setAttribute('role', 'menuitemradio');
    item.addEventListener('click', () => {
      setRate(value);
      speedMenu.hidden = true;
      $('rate').focus();
    });
    return item;
  }));
  const closeMenus = () => {
    speedMenu.hidden = true;
    $('settings-menu').hidden = true;
    $('settings').setAttribute('aria-expanded', 'false');
  };
  $('rate').addEventListener('click', () => {
    const open = speedMenu.hidden;
    closeMenus();
    speedMenu.hidden = !open;
    if (open) (speedMenu.querySelector('[aria-checked="true"]') || speedMenu.firstElementChild).focus();
  });
  $('settings').addEventListener('click', () => {
    const open = $('settings-menu').hidden;
    closeMenus();
    $('settings-menu').hidden = !open;
    $('settings').setAttribute('aria-expanded', String(open));
  });
  document.addEventListener('click', clickEvent => {
    if (!clickEvent.target.closest('.menu, #rate, #settings')) closeMenus();
  });
  $('voice').addEventListener('change', () => post({ type: 'setting', key: 'voice', value: $('voice').value }));
  $('table-mode').addEventListener('change', () => post({ type: 'setting', key: 'tableMode', value: $('table-mode').value }));
  $('code-blocks').addEventListener('change', () => post({ type: 'setting', key: 'codeBlocks', value: $('code-blocks').value }));
  $('words').addEventListener('change', () => {
    settings.highlightWords = $('words').checked;
    if (!settings.highlightWords) clearWord();
    post({ type: 'setting', key: 'highlightWords', value: settings.highlightWords });
  });
  $('editor-follow').addEventListener('change', () => post({ type: 'setting', key: 'followInEditor', value: $('editor-follow').checked }));
  $('follow').addEventListener('change', () => {
    follow = $('follow').checked;
    if (follow) scrollToCurrent(true);
    else updatePill();
  });
  $('engine-switch').addEventListener('click', () => {
    closeMenus();
    post({ type: engine.kind === 'system' ? 'useNatural' : 'useSystem' });
  });
  const shortcuts = $('shortcuts');
  const toggleShortcuts = show => {
    shortcuts.hidden = !show;
    if (show) $('close-shortcuts').focus();
  };
  $('show-shortcuts').addEventListener('click', () => {
    closeMenus();
    toggleShortcuts(true);
  });
  $('close-shortcuts').addEventListener('click', () => toggleShortcuts(false));

  // Reading position follows the voice until the listener scrolls it out of view.
  window.addEventListener('scroll', () => {
    if (performance.now() < programmaticUntil) return;
    follow = false;
    updatePill();
  }, { passive: true });
  window.addEventListener('scrollend', () => {
    if (performance.now() < programmaticUntil) programmaticUntil = 0;
  });

  $('doc').addEventListener('click', clickEvent => {
    const target = clickEvent.target;
    if (!(target instanceof Element) || target.closest('button, .describe-box, .block-tools')) return;
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed && selection.toString().trim()) return;
    const link = target.closest('.link');
    if (link && (clickEvent.ctrlKey || clickEvent.metaKey)) {
      post({ type: 'openLink', href: link.dataset.href });
      return;
    }
    let found;
    const word = target.closest('.w');
    if (word && wordIndex.has(word.id)) found = wordIndex.get(word.id);
    for (let element = target; !found && element && element !== $('doc'); element = element.parentElement) {
      if (element.id && elementIndex.has(element.id)) found = [elementIndex.get(element.id), -1];
    }
    if (!found) return;
    const [i, k] = found;
    if (clickEvent.altKey) {
      post({ type: 'reveal', index: i });
      return;
    }
    follow = true;
    $('follow').checked = true;
    const entry = cache.get(i);
    const start = k >= 0 && entry ? entry.times[2 * k] : -1;
    pendingWord = k >= 0 && !entry ? { index: i, word: k } : null;
    go(i, start > 0 ? Math.max(0, start - 0.05) : 0, engine.state === 'ready');
  });

  document.addEventListener('keydown', keyEvent => {
    const target = keyEvent.target;
    if (keyEvent.key === 'Escape') {
      closeMenus();
      toggleShortcuts(false);
      return;
    }
    if (target instanceof Element && target.closest('select, textarea, input:not([type=range]):not([type=checkbox]), .menu')) return;
    if (keyEvent.ctrlKey || keyEvent.metaKey || keyEvent.altKey) return;
    const onButton = target instanceof Element && target.closest('button');
    const key = keyEvent.key;
    const actions = {
      ' ': () => { if (!onButton) toggle(); else return false; },
      k: toggle, K: toggle,
      j: () => seekTo(now() - settings.skipBack), J: () => seekTo(now() - settings.skipBack),
      l: () => seekTo(now() + settings.skipForward), L: () => seekTo(now() + settings.skipForward),
      ArrowLeft: () => (keyEvent.shiftKey ? sentence(-1) : seekTo(now() - settings.skipBack)),
      ArrowRight: () => (keyEvent.shiftKey ? sentence(1) : seekTo(now() + settings.skipForward)),
      ArrowUp: () => (keyEvent.shiftKey ? paragraph(-1) : false),
      ArrowDown: () => (keyEvent.shiftKey ? paragraph(1) : false),
      ',': () => sentence(-1), '.': () => sentence(1),
      '[': () => paragraph(-1), ']': () => paragraph(1),
      '-': () => stepRate(-1), _: () => stepRate(-1), '=': () => stepRate(1), '+': () => stepRate(1),
      Home: () => go(0, 0),
      f: () => { follow = true; $('follow').checked = true; scrollToCurrent(true); },
      F: () => { follow = true; $('follow').checked = true; scrollToCurrent(true); },
      '?': () => toggleShortcuts(shortcuts.hidden)
    };
    const action = actions[key];
    if (!action) return;
    if (action() === false) return;
    keyEvent.preventDefault();
  });

  // Audio sent while the panel was hidden may not arrive; ask again when it is shown.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    lastNeed = '';
    requestNeeded();
    updateTime();
  });

  // Lets keyboard and headset media keys control the reader where the platform supports it.
  if (navigator.mediaSession) {
    const handlers = {
      play, pause, stop: pause,
      seekbackward: () => seekTo(now() - settings.skipBack),
      seekforward: () => seekTo(now() + settings.skipForward),
      previoustrack: () => sentence(-1),
      nexttrack: () => sentence(1)
    };
    for (const [action, handler] of Object.entries(handlers)) {
      try {
        navigator.mediaSession.setActionHandler(action, () => handler());
      } catch {
        // Unsupported actions are simply not offered.
      }
    }
  }

  window.addEventListener('message', ({ data }) => {
    switch (data.type) {
      case 'plan': onPlan(data); break;
      case 'engine': onEngine(data); break;
      case 'audio': onAudio(data); break;
      case 'stale': stale = true; renderBanner(); break;
      case 'settings':
        Object.assign(settings, { highlightWords: data.highlightWords, followInEditor: data.followInEditor, skipBack: data.skipBack, skipForward: data.skipForward });
        if (Math.abs(data.rate - rate) > 0.001) setRate(data.rate, false);
        $('words').checked = settings.highlightWords;
        $('editor-follow').checked = settings.followInEditor;
        if (!settings.highlightWords) clearWord();
        $('back').title = `Back ${settings.skipBack} seconds (← or J)`;
        $('back').setAttribute('aria-label', `Back ${settings.skipBack} seconds`);
        $('forward').title = `Forward ${settings.skipForward} seconds (→ or L)`;
        $('forward').setAttribute('aria-label', `Forward ${settings.skipForward} seconds`);
        for (const [id, value] of [['back', settings.skipBack], ['forward', settings.skipForward]]) {
          const label = $(id).querySelector('text');
          if (label) label.textContent = String(value);
        }
        updateTime();
        break;
      case 'description': showDescription(data); break;
      case 'error':
        if (data.revision !== undefined && data.revision !== revision) return;
        if (data.index === undefined || data.index === index) {
          error = data.message;
          if (playing && loaded !== index) {
            playing = false;
            playToken++;
          }
        }
        updateControls();
        break;
      case 'command': {
        const commands = {
          togglePlay: toggle, play, pause, stop: pause,
          skipBack: () => seekTo(now() - settings.skipBack), skipForward: () => seekTo(now() + settings.skipForward),
          previousSentence: () => sentence(-1), nextSentence: () => sentence(1),
          previousParagraph: () => paragraph(-1), nextParagraph: () => paragraph(1),
          faster: () => stepRate(1), slower: () => stepRate(-1)
        };
        commands[data.action]?.();
        break;
      }
    }
  });

  updateControls();
  post({ type: 'ready' });
})();
