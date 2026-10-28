/* global acquireVsCodeApi */
(() => {
  'use strict';
  const vscode = acquireVsCodeApi();
  const byId = id => document.getElementById(id);
  const audio = byId('audio');
  let segments = [];
  let index = 0;
  let request = 0;
  let revision = 0;
  let playing = false;
  let waiting = false;
  let loaded = -1;

  function showError(message) {
    byId('error').textContent = message;
    byId('error').hidden = false;
  }

  function update() {
    byId('play').textContent = playing ? 'Pause' : 'Play';
    byId('previous').disabled = index === 0;
    byId('next').disabled = index >= segments.length - 1;
    byId('play').disabled = segments.length === 0;
    byId('status').textContent = `${waiting ? 'Preparing local speech' : playing ? 'Reading' : 'Paused'}: passage ${index + 1} of ${segments.length}`;
    for (const [position, item] of [...byId('passages').children].entries()) {
      item.classList.toggle('current', position === index);
      if (position === index) item.setAttribute('aria-current', 'step');
      else item.removeAttribute('aria-current');
    }
  }

  function pause() {
    playing = false;
    audio.pause();
    update();
  }

  async function playAudio() {
    const attempt = request;
    try { await audio.play(); }
    catch (error) {
      if (attempt !== request || !playing) return;
      pause();
      showError(`Audio playback failed: ${error.message}. Check your desktop audio output, then press Play to retry.`);
    }
  }

  function load() {
    audio.pause();
    audio.removeAttribute('src');
    loaded = -1;
    waiting = true;
    vscode.postMessage({ type: 'audio', index, request: ++request });
    byId('error').hidden = true;
    update();
  }

  function startAt(position) {
    if (position < 0 || position >= segments.length) return;
    index = position;
    playing = true;
    load();
    byId('passages').children[index]?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
  }

  byId('play').addEventListener('click', () => {
    if (playing) return pause();
    if (!segments.length) return;
    playing = true;
    if (loaded === index) {
      void playAudio();
      update();
    } else load();
  });
  byId('stop').addEventListener('click', () => {
    pause();
    request++;
    index = 0;
    waiting = false;
    loaded = -1;
    audio.removeAttribute('src');
    audio.load();
    update();
  });
  byId('previous').addEventListener('click', () => startAt(index - 1));
  byId('next').addEventListener('click', () => startAt(index + 1));
  byId('rate').addEventListener('change', event => { audio.playbackRate = Number(event.target.value); });
  byId('voice').addEventListener('change', event => {
    pause();
    request++;
    vscode.postMessage({ type: 'voice', voice: event.target.value });
  });
  byId('tableMode').addEventListener('change', event => {
    pause();
    request++;
    vscode.postMessage({ type: 'tableMode', mode: event.target.value });
  });
  audio.addEventListener('ended', () => {
    if (!playing) return;
    if (index + 1 < segments.length) startAt(index + 1);
    else {
      pause();
      loaded = -1;
      byId('status').textContent = 'Finished reading. Press Play to replay the last passage, or Stop to return to the beginning.';
    }
  });
  audio.addEventListener('error', () => {
    if (!audio.getAttribute('src')) return;
    pause();
    loaded = -1;
    showError('The generated audio could not be played. Press Play to retry, or select a different system voice.');
  });
  byId('ai').addEventListener('click', () => {
    pause();
    byId('ai').disabled = true;
    byId('error').hidden = true;
    vscode.postMessage({ type: 'ai' });
  });
  byId('original').addEventListener('click', () => { pause(); vscode.postMessage({ type: 'original' }); });
  for (const [id, type] of [['apply', 'applyAI'], ['discard', 'discardAI']]) {
    byId(id).addEventListener('click', () => {
      pause();
      byId('proposal').hidden = true;
      vscode.postMessage({ type });
    });
  }

  function renderComparison(id, items) {
    byId(id).replaceChildren(...items.map(segment => {
      const paragraph = document.createElement('p');
      paragraph.textContent = segment.text;
      return paragraph;
    }));
  }

  window.addEventListener('message', event => {
    const message = event.data;
    if (message.type === 'plan') {
      pause();
      request++;
      waiting = false;
      loaded = -1;
      audio.removeAttribute('src');
      audio.load();
      index = 0;
      revision = message.revision;
      segments = message.segments;
      byId('proposal').hidden = true;
      byId('ai').disabled = false;
      byId('original').hidden = !message.ai;
      byId('voice').replaceChildren(new Option('System default', ''), ...message.voices.map(voice => new Option(voice.label, voice.id)));
      byId('voice').value = message.voice;
      byId('tableMode').value = message.tableMode;
      if (![...byId('rate').options].some(option => Number(option.value) === message.rate)) {
        byId('rate').add(new Option(`${message.rate}x`, String(message.rate)));
      }
      byId('rate').value = String(message.rate);
      audio.playbackRate = message.rate;
      byId('passages').replaceChildren(...segments.map((segment, position) => {
        const item = document.createElement('li');
        const read = document.createElement('button');
        read.className = 'passage';
        read.textContent = segment.text;
        read.setAttribute('aria-label', `Read passage ${position + 1}: ${segment.text}`);
        read.addEventListener('click', () => startAt(position));
        const source = document.createElement('button');
        source.textContent = 'Source';
        source.className = 'source';
        source.setAttribute('aria-label', `Reveal source for passage ${position + 1}`);
        source.addEventListener('click', () => vscode.postMessage({ type: 'reveal', index: position }));
        item.append(read, source);
        return item;
      }));
      update();
    } else if (message.type === 'audio') {
      if (message.request !== request || message.revision !== revision || message.index !== index) return;
      waiting = false;
      loaded = index;
      audio.src = message.uri;
      audio.playbackRate = Number(byId('rate').value);
      if (playing) void playAudio();
      update();
    } else if (message.type === 'error') {
      if (message.request !== undefined && message.request !== request) return;
      pause();
      waiting = false;
      byId('ai').disabled = false;
      showError(message.message);
      update();
    } else if (message.type === 'aiDone') {
      byId('ai').disabled = false;
    } else if (message.type === 'proposal') {
      pause();
      byId('ai').disabled = false;
      renderComparison('before', message.original);
      renderComparison('after', message.segments);
      byId('proposal').hidden = false;
      byId('proposal').scrollIntoView?.({ block: 'start', behavior: 'smooth' });
    }
  });

  document.addEventListener('keydown', event => {
    if (event.target.closest('button, select, input, textarea')) return;
    if (event.code === 'Space') { event.preventDefault(); byId('play').click(); }
    if (event.altKey && event.code === 'ArrowRight') { event.preventDefault(); byId('next').click(); }
    if (event.altKey && event.code === 'ArrowLeft') { event.preventDefault(); byId('previous').click(); }
  });
  vscode.postMessage({ type: 'ready' });
})();
