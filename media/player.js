/* global acquireVsCodeApi */
(() => {
  'use strict';
  const vscode = acquireVsCodeApi();
  const $ = id => document.getElementById(id);
  const SPEEDS = [...$('rate').options].map(option => Number(option.value));
  /** Longest run of consecutive passages joined into one continuous track. */
  const MAX_TRACK_SECONDS = 120;
  /** How long before a track ends (wall-clock seconds) the next one is prepared in the other player. */
  const PREPARE_SECONDS = 5;
  /** The next track starts this much before the current one ends, inside the pause every passage ends with. */
  const EARLY = 0.03;
  const ICON_PLAY = $('play').innerHTML;
  const ICON_PAUSE = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M7 5h4v14H7zm6 0h4v14h-4z"/></svg>';
  const SILENT = URL.createObjectURL(wavBlob([new Uint8Array(1600)], { sampleRate: 8000, channels: 1, bits: 16, blockAlign: 2 }));

  let revision = -1;
  let loaded = false;
  let utterances = [];
  let blocks = [];
  let selection = false;
  let settings = { skipBack: 10, skipForward: 30, highlightWords: true, followInEditor: true, tableMode: 'rows', codeBlocks: 'announce' };
  let engine = { state: 'idle', voices: [], voice: '', kind: 'natural' };
  /** Synthesized audio by passage: raw PCM, its format, exact duration and word timings. */
  const segments = new Map();
  let segmentBytes = 0;
  let prefix = [0];
  let cps = 14.5;
  let spokenChars = 0;
  let spokenSeconds = 0;
  let index = 0;
  let word = -1;
  /** The listener wants sound. While `waiting`, the audio for `index` has not arrived yet. */
  let playing = false;
  let waiting = false;
  let finished = false;
  let autoplay = false;
  let pendingOffset = 0;
  let pendingWord = null;
  let rate = 1;
  /** Volume slider position (0–100) and mute, which keeps the position to restore. */
  let volume = 100;
  let muted = false;
  let lastAudible = 100;
  let draggingVolume = false;
  let volumeTimer = 0;
  /** A short message (such as the new volume) shown in the status line for a moment. */
  let notice = '';
  let noticeTimer = 0;
  let stale = false;
  let error = '';
  let unlocked = false;
  let scrubbing = false;
  let handoffTimer = 0;
  let tickTimer = 0;
  let rateTimer = 0;
  let playToken = 0;
  let stallStarted = 0;
  let expectedStart = 0;
  let lastNeed = '';
  let lastReport = 0;
  let reported = { index: -1, word: -2, playing: null, waiting: null };
  const once = new Set();

  const post = message => vscode.postMessage(message);
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const describe = failure => (failure && typeof failure === 'object' ? `${failure.name || 'Error'}: ${failure.message || ''}` : String(failure));
  const formatRate = value => `${Number(value.toFixed(2))}×`;
  const clock = seconds => {
    const s = Math.max(0, Math.round(seconds));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const rest = String(s % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${rest}` : `${m}:${rest}`;
  };
  /** Reports a diagnostic event to the extension, once per document unless `repeat` is set. */
  const event = (name, repeat = false) => {
    if (!repeat) {
      if (once.has(name)) return;
      once.add(name);
    }
    post({ type: 'event', event: name });
  };

  function wavBlob(parts, format) {
    const length = parts.reduce((sum, part) => sum + part.byteLength, 0);
    const view = new DataView(new ArrayBuffer(44));
    const text = (offset, value) => [...value].forEach((ch, i) => view.setUint8(offset + i, ch.charCodeAt(0)));
    text(0, 'RIFF');
    view.setUint32(4, 36 + length, true);
    text(8, 'WAVEfmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, format.channels, true);
    view.setUint32(24, format.sampleRate, true);
    view.setUint32(28, format.sampleRate * format.blockAlign, true);
    view.setUint16(32, format.blockAlign, true);
    view.setUint16(34, format.bits, true);
    text(36, 'data');
    view.setUint32(40, length, true);
    return new Blob([view.buffer, ...parts], { type: 'audio/wav' });
  }

  // Two players take turns: one plays a track while the other loads the next, so passages join without gaps.
  function createPlayer() {
    const el = new Audio();
    el.preload = 'auto';
    el.preservesPitch = true;
    const player = { el, track: null };
    el.addEventListener('ended', () => { if (player === current()) onEnded(); });
    el.addEventListener('timeupdate', () => { if (player === current() && playing) tick(); });
    el.addEventListener('playing', () => { if (player === current()) onPlaying(); });
    el.addEventListener('error', () => onMediaError(player));
    return player;
  }
  const players = [createPlayer(), createPlayer()];
  let active = 0;
  const current = () => players[active];
  const spare = () => players[1 - active];
  const holds = (player, i) => !!player.track && i >= player.track.start && i < player.track.end;

  function duration(i) {
    const segment = segments.get(i);
    if (segment) return segment.duration;
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

  /** Seconds into the current passage. */
  function offsetNow() {
    const player = current();
    if (!waiting && holds(player, index)) return Math.max(0, (player.el.currentTime || 0) - player.track.offsets[index - player.track.start]);
    return pendingOffset;
  }

  const now = () => (prefix[index] || 0) + offsetNow();

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

  const sameFormat = (a, b) => a.sampleRate === b.sampleRate && a.channels === b.channels && a.bits === b.bits;

  /** Joins the synthesized passages from `start` onwards into one continuous WAV. */
  function buildTrack(start) {
    const first = segments.get(start);
    if (!first) return null;
    const parts = [];
    const offsets = [];
    let length = 0;
    let end = start;
    while (end < utterances.length && length < MAX_TRACK_SECONDS) {
      const segment = segments.get(end);
      if (!segment || !sameFormat(segment.format, first.format)) break;
      offsets.push(length);
      parts.push(segment.pcm);
      length += segment.duration;
      end++;
    }
    return { start, end, offsets, duration: length, url: URL.createObjectURL(wavBlob(parts, first.format)) };
  }

  function setTrack(player, track) {
    const old = player.track;
    player.track = track;
    player.el.pause();
    if (track) player.el.src = track.url;
    else if (player.el.getAttribute('src')) {
      player.el.removeAttribute('src');
      player.el.load();
    }
    player.el.defaultPlaybackRate = rate;
    player.el.playbackRate = rate;
    if (old) URL.revokeObjectURL(old.url);
  }

  function seekPlayer(player, i, offset) {
    const target = player.track.offsets[i - player.track.start] + offset;
    // Even a seek to the same time flushes and refills the pipeline, which would delay a prepared track.
    if (Math.abs((player.el.currentTime || 0) - target) < 0.002) return;
    try {
      player.el.currentTime = target;
    } catch {
      // Before metadata loads Chromium keeps this as the start position.
    }
  }

  async function playElement(player) {
    const token = ++playToken;
    player.el.defaultPlaybackRate = rate;
    player.el.playbackRate = rate;
    try {
      await player.el.play();
      if (token === playToken) {
        $('start').hidden = true;
        event('playing');
      }
    } catch (failure) {
      if (token !== playToken || player !== current() || !playing) return;
      if (failure && failure.name === 'AbortError') return;
      playing = false;
      waiting = false;
      stopTicking();
      if (failure && failure.name === 'NotAllowedError') needGesture();
      else {
        event(`play-error ${describe(failure)}`, true);
        error = 'Press Play to start listening.';
      }
      updateControls();
      report(true);
    }
  }

  /** Moves to passage `i`, `offset` seconds in, and plays if `play`. */
  function go(i, offset = 0, play = playing) {
    if (!utterances.length) return;
    i = clamp(i, 0, utterances.length - 1);
    error = '';
    finished = false;
    playing = play && engine.state === 'ready';
    clearHandoff();
    if (!pendingWord || pendingWord.index !== i) pendingWord = null;
    index = i;
    word = -1;
    pendingOffset = Math.max(0, offset);
    if (!holds(current(), i) && holds(spare(), i)) {
      current().el.pause();
      active = 1 - active;
    }
    const player = current();
    spare().el.pause();
    if (!holds(player, i)) setTrack(player, buildTrack(i));
    waiting = false;
    if (player.track) {
      seekPlayer(player, i, pendingOffset);
      if (playing) void playElement(player);
      else player.el.pause();
    } else {
      playToken++;
      waiting = playing;
    }
    if (playing) startTicking();
    else stopTicking();
    requestNeeded();
    updateControls();
    updateTime();
    report(true);
  }

  function goWord(i, k, play) {
    const segment = segments.get(i);
    const start = segment && k >= 0 ? segment.times[2 * k] : -1;
    pendingWord = k >= 0 && !segment ? { index: i, word: k } : null;
    go(i, start > 0 ? Math.max(0, start - 0.05) : 0, play);
  }

  function play() {
    if (!loaded) {
      post({ type: 'readActive' });
      return;
    }
    if (engine.state !== 'ready' || !utterances.length) return;
    if (finished) return go(0, 0, true);
    const player = current();
    if (holds(player, index) && !waiting) {
      playing = true;
      error = '';
      void playElement(player);
      startTicking();
      requestNeeded();
      updateControls();
      report(true);
      return;
    }
    go(index, pendingOffset, true);
  }

  function pause() {
    if (holds(current(), index) && !waiting) pendingOffset = offsetNow();
    playing = false;
    waiting = false;
    playToken++;
    clearHandoff();
    for (const player of players) player.el.pause();
    stopTicking();
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
    if (step < 0 && offsetNow() > 1.5) return go(index, 0);
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
    const insideBlock = start < index || offsetNow() > 1.5;
    if (!insideBlock && start > 0) {
      const previous = utterances[--start].b;
      while (start > 0 && utterances[start - 1].b === previous) start--;
    }
    go(start, 0);
  }

  function startTicking() {
    if (!tickTimer) tickTimer = setInterval(tick, 50);
  }

  function stopTicking() {
    clearInterval(tickTimer);
    tickTimer = 0;
  }

  function clearHandoff() {
    clearTimeout(handoffTimer);
    handoffTimer = 0;
  }

  /** Follows the audio clock: passage, word, the next track and the handoff to it. */
  function tick() {
    const player = current();
    if (!playing || waiting || !player.track) return;
    const time = player.el.currentTime || 0;
    const { offsets, start } = player.track;
    let k = clamp(index - start, 0, offsets.length - 1);
    while (k + 1 < offsets.length && offsets[k + 1] <= time) k++;
    while (k > 0 && offsets[k] > time) k--;
    if (start + k !== index) {
      index = start + k;
      word = -1;
      updateControls();
    }
    updateWord(time - offsets[k]);
    const remaining = (player.track.duration - time) / rate;
    if (remaining < PREPARE_SECONDS) prepareNext();
    if (remaining < 0.4 && !handoffTimer) scheduleHandoff(remaining);
    updateTime();
    report();
  }

  function updateWord(offset) {
    const segment = segments.get(index);
    let k = -1;
    if (segment) {
      for (let j = 0; j * 2 < segment.times.length; j++) {
        const start = segment.times[2 * j];
        if (start < 0) continue;
        if (start <= offset + 0.03) k = j;
        else break;
      }
    }
    word = k;
  }

  function prepareNext() {
    const player = current();
    const next = spare();
    if (!player.track || player.track.end >= utterances.length) return;
    if (next.track && next.track.start === player.track.end) return;
    const track = buildTrack(player.track.end);
    if (!track) return;
    setTrack(next, track);
    seekPlayer(next, track.start, 0);
  }

  function scheduleHandoff(remaining) {
    const player = current();
    const next = spare();
    if (!player.track || !next.track || next.track.start !== player.track.end) return;
    expectedStart = performance.now() + remaining * 1000;
    handoffTimer = setTimeout(() => {
      handoffTimer = 0;
      if (!playing || player !== current() || !player.track) return;
      const left = (player.track.duration - (player.el.currentTime || 0)) / rate;
      // Speech may have been held up (for example by a slow decode); never cut a track short.
      if (left > EARLY + 0.02) scheduleHandoff(left);
      else handoff();
    }, Math.max(0, (remaining - EARLY) * 1000));
  }

  /** Starts the prepared next track. Returns false if there is none. */
  function handoff() {
    const player = current();
    const next = spare();
    if (!playing || !player.track || !next.track || next.track.start !== player.track.end) return false;
    active = 1 - active;
    index = next.track.start;
    word = -1;
    pendingOffset = 0;
    waiting = false;
    seekPlayer(next, index, 0);
    void playElement(next);
    requestNeeded();
    updateControls();
    report(true);
    return true;
  }

  function onPlaying() {
    if (!expectedStart) return;
    // How much later than the previous track's end the next one started; negative is early (inside the pause).
    event(`gap ${Math.round(performance.now() - expectedStart)}`, true);
    expectedStart = 0;
  }

  function onEnded() {
    if (!playing) return;
    clearHandoff();
    if (handoff()) return;
    const player = current();
    const next = player.track ? player.track.end : index + 1;
    if (next >= utterances.length) return finish();
    index = next;
    word = -1;
    pendingOffset = 0;
    expectedStart = 0;
    setTrack(player, buildTrack(next));
    if (player.track) {
      // The next audio arrived too late to be prepared in the other player: start it now.
      event('late-start', true);
      seekPlayer(player, next, 0);
      void playElement(player);
    } else {
      waiting = true;
      stallStarted = performance.now();
      event(`stall ${next}`, true);
    }
    requestNeeded();
    updateControls();
    updateTime();
    report(true);
  }

  function finish() {
    playing = false;
    waiting = false;
    finished = true;
    word = -1;
    stopTicking();
    clearHandoff();
    updateControls();
    updateTime();
    report(true);
    event('finished');
  }

  function onMediaError(player) {
    if (!player.el.getAttribute('src') || player.el.getAttribute('src') === SILENT) return;
    const failure = player.el.error;
    event(`audio-error ${failure ? `${failure.code} ${failure.message}` : 'unknown'}`, true);
    if (player !== current() || !playing) return;
    pause();
    error = 'This passage could not be played. Press Play to try again.';
    setTrack(player, null);
    updateControls();
  }

  function onAudio(message) {
    if (message.revision !== revision || !utterances[message.index]) return;
    const i = message.index;
    const old = segments.get(i);
    if (old) segmentBytes -= old.pcm.byteLength;
    const seconds = message.pcm.byteLength / (message.format.sampleRate * message.format.blockAlign);
    segments.set(i, { pcm: message.pcm, format: message.format, duration: seconds, times: message.times });
    segmentBytes += message.pcm.byteLength;
    event('audio');
    const u = utterances[i];
    const speech = seconds - u.p;
    if (!old && speech > 0.4 && u.c > 8) {
      spokenChars += u.c;
      spokenSeconds += speech;
      cps = clamp(spokenChars / spokenSeconds, 8, 25);
    }
    rebuildTimeline();
    const player = current();
    if (i === index && !holds(player, index)) {
      if (pendingWord && pendingWord.index === i) {
        const start = message.times[2 * pendingWord.word];
        if (start >= 0) pendingOffset = Math.max(0, start - 0.05);
      }
      pendingWord = null;
      setTrack(player, buildTrack(i));
      seekPlayer(player, i, pendingOffset);
      if (waiting && stallStarted) event(`stall-end ${Math.round(performance.now() - stallStarted)}`, true);
      stallStarted = 0;
      waiting = false;
      if (playing) {
        void playElement(player);
        startTicking();
      }
      updateControls();
      report(true);
    } else if (!playing && player.track && i === player.track.end && holds(player, index)) {
      // Paused: extend the loaded track so playback continues through what has arrived without a switch.
      const offset = offsetNow();
      setTrack(player, buildTrack(index));
      seekPlayer(player, index, offset);
    } else if (playing && player.track && i >= player.track.end && (player.track.duration - (player.el.currentTime || 0)) / rate < PREPARE_SECONDS) {
      prepareNext();
    }
    evict();
    requestNeeded();
    updateTime();
  }

  function evict() {
    if (segmentBytes < 200 * 1024 * 1024) return;
    const keep = i => Math.abs(i - index) < 80 || players.some(player => holds(player, i));
    for (const [i, segment] of segments) {
      if (segmentBytes < 150 * 1024 * 1024) break;
      if (keep(i)) continue;
      segmentBytes -= segment.pcm.byteLength;
      segments.delete(i);
    }
  }

  /** Seconds of playback, at the current speed, that are ready from the current position on. */
  function bufferedAhead() {
    let seconds = -offsetNow();
    for (let i = index; i < utterances.length && segments.has(i); i++) seconds += segments.get(i).duration;
    return Math.max(0, seconds) / rate;
  }

  function requestNeeded() {
    if (engine.state !== 'ready' || !utterances.length) return;
    const wanted = [];
    let ahead = 0;
    for (let i = index; i < utterances.length && wanted.length < 40 && ahead < 150; i++) {
      if (!segments.has(i)) wanted.push(i);
      ahead += duration(i);
    }
    const key = `${revision}:${wanted.join(',')}`;
    if (key === lastNeed) return;
    lastNeed = key;
    if (wanted.length) post({ type: 'need', revision, indices: wanted, ahead: bufferedAhead(), rate });
  }

  function resetAudio() {
    for (const player of players) setTrack(player, null);
    segments.clear();
    segmentBytes = 0;
    lastNeed = '';
    playToken++;
    clearHandoff();
    stopTicking();
    expectedStart = 0;
    stallStarted = 0;
  }

  function setRate(value, persist = true) {
    const wanted = Number(value) || 1;
    rate = SPEEDS.reduce((best, speed) => (Math.abs(speed - wanted) < Math.abs(best - wanted) ? speed : best), 1);
    for (const player of players) {
      player.el.defaultPlaybackRate = rate;
      player.el.playbackRate = rate;
    }
    clearHandoff();
    $('rate').value = String(rate);
    updateTime();
    report(true);
    if (!persist) return;
    clearTimeout(rateTimer);
    rateTimer = setTimeout(() => {
      rateTimer = 0;
      post({ type: 'setting', key: 'rate', value: rate });
    }, 300);
  }

  function stepRate(step) {
    const position = SPEEDS.indexOf(rate);
    setRate(SPEEDS[clamp((position < 0 ? SPEEDS.indexOf(1) : position) + step, 0, SPEEDS.length - 1)]);
  }

  function applyVolume() {
    // Loudness is perceived roughly logarithmically: squaring the position makes the slider feel even.
    const gain = (volume / 100) ** 2;
    for (const player of players) {
      player.el.volume = gain;
      player.el.muted = muted;
    }
  }

  function renderVolume() {
    const slider = $('volume');
    const silent = muted || volume === 0;
    slider.style.setProperty('--level', String(volume / 100));
    slider.setAttribute('aria-valuenow', String(volume));
    slider.setAttribute('aria-valuetext', muted ? `Muted (${volume}%)` : `${volume}%`);
    slider.title = muted ? `Muted (${volume}%). Drag to unmute.` : `Volume ${volume}% (↑ / ↓)`;
    slider.parentElement.classList.toggle('muted', muted);
    const level = silent ? 'off' : volume < 50 ? 'low' : 'high';
    for (const svg of $('mute').querySelectorAll('svg')) {
      if (svg.dataset.level === level) svg.removeAttribute('hidden');
      else svg.setAttribute('hidden', '');
    }
    $('mute').setAttribute('aria-label', silent ? 'Unmute' : 'Mute');
    $('mute').setAttribute('aria-pressed', String(silent));
    $('mute').title = silent ? 'Unmute (M)' : 'Mute (M)';
  }

  function flash(text) {
    notice = text;
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => {
      notice = '';
      updateControls();
    }, 1500);
    updateControls();
  }

  /** Changes the volume from the player's own controls, unmuting, and saves it shortly after. */
  function setVolume(value) {
    const level = Math.round(clamp(Number(value) || 0, 0, 100));
    volume = level;
    if (level > 0) {
      muted = false;
      lastAudible = level;
    }
    applyVolume();
    renderVolume();
    flash(level ? `Volume ${level}%` : 'Muted');
    report(true);
    clearTimeout(volumeTimer);
    volumeTimer = setTimeout(() => {
      volumeTimer = 0;
      post({ type: 'setting', key: 'volume', value: volume });
    }, 300);
  }

  /** Applies a volume saved in the settings, unless the listener is changing it right now. */
  function syncVolume(value) {
    if (typeof value !== 'number' || !Number.isFinite(value) || draggingVolume || volumeTimer) return;
    volume = Math.round(clamp(value, 0, 100));
    if (volume > 0) lastAudible = volume;
    applyVolume();
    renderVolume();
  }

  const stepVolume = step => setVolume((muted ? 0 : volume) + step);

  function toggleMute() {
    if (muted || volume === 0) {
      if (volume === 0) return setVolume(lastAudible || 50);
      muted = false;
      flash(`Volume ${volume}%`);
    } else {
      muted = true;
      flash('Muted');
    }
    applyVolume();
    renderVolume();
    report(true);
  }

  function report(force) {
    const time = performance.now();
    const changed = index !== reported.index || word !== reported.word || playing !== reported.playing || waiting !== reported.waiting;
    if (!force && !changed && time - lastReport < 1000) return;
    lastReport = time;
    reported = { index, word, playing, waiting };
    if (navigator.mediaSession) navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
    if (loaded) post({ type: 'position', revision, index, word, offset: offsetNow(), playing, waiting, finished, elapsed: now(), total: total(), rate, volume, muted });
  }

  function setStatus(text) {
    if ($('status').textContent !== text) $('status').textContent = text;
  }

  function section() {
    let heading;
    for (const block of blocks) {
      if (block.k !== 'heading' || block.f < 0) continue;
      if (block.f > index) break;
      heading = block;
    }
    return heading ? heading.t : '';
  }

  function updateControls() {
    const ready = loaded && engine.state === 'ready' && utterances.length > 0;
    const play = $('play');
    play.innerHTML = playing ? ICON_PAUSE : ICON_PLAY;
    play.title = playing ? 'Pause (Space)' : loaded ? 'Play (Space)' : 'Read the open Markdown file';
    play.setAttribute('aria-label', playing ? 'Pause' : 'Play');
    play.classList.toggle('waiting', playing && waiting);
    play.disabled = loaded && !ready;
    for (const id of ['back', 'forward', 'previous', 'next', 'seek']) $(id).disabled = !ready;
    $('idle').hidden = loaded;
    const heading = loaded ? section() : '';
    if ($('section').textContent !== heading) {
      $('section').textContent = heading;
      $('section').title = heading;
    }
    if (error) setStatus(error);
    else if (notice) setStatus(notice);
    else if (!loaded) setStatus('');
    else if (!ready) setStatus(engine.state === 'loading' ? engine.message || 'Starting the voice…' : '');
    else if (playing && waiting) setStatus('Preparing audio…');
    else if (finished) setStatus('Finished. Press Play to listen again.');
    else setStatus(playing ? '' : 'Paused');
  }

  function updateTime() {
    const elapsed = now();
    const length = total();
    const estimated = utterances.some((_, i) => i >= index && !segments.has(i));
    if (!scrubbing) {
      $('seek').max = String(Math.max(1, length));
      $('seek').value = String(elapsed);
      $('elapsed').textContent = loaded ? clock(elapsed) : '';
    }
    $('seek').setAttribute('aria-valuetext', `${clock(elapsed)} of ${clock(length)}`);
    $('remaining').textContent = loaded ? `${estimated ? '~' : ''}${clock((length - elapsed) / rate)} left` : '';
    $('remaining').title = estimated ? 'Estimated time left at this speed; it becomes exact as audio is prepared' : 'Time left at this speed';
  }

  function renderChapters() {
    const length = total();
    $('chapters').replaceChildren(...blocks.filter(block => block.k === 'heading' && block.f >= 0 && block.l <= 3).map(block => {
      const mark = document.createElement('span');
      mark.className = 'chapter';
      mark.style.left = `${length ? (prefix[block.f] / length) * 100 : 0}%`;
      mark.title = block.t;
      return mark;
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
    element.className = primary ? 'primary-button' : 'secondary-button';
    element.addEventListener('click', action);
    return element;
  }

  function paragraphOf(text, className) {
    const element = document.createElement('p');
    element.textContent = text;
    if (className) element.className = className;
    return element;
  }

  function renderSetup() {
    const parts = [];
    if (loaded && engine.state === 'missing') {
      parts.push(paragraphOf(`The natural voice is a one-time ${engine.sizeMB} MB download. It then runs entirely on this computer.`));
      if (engine.message) parts.push(paragraphOf(engine.message, 'detail'));
      parts.push(button(`Download (${engine.sizeMB} MB)`, () => post({ type: 'install' }), true), button('Use system voice', () => post({ type: 'useSystem' })));
    } else if (loaded && engine.state === 'downloading') {
      const bar = document.createElement('progress');
      bar.max = 100;
      bar.value = engine.progress;
      parts.push(paragraphOf(`Downloading the natural voice… ${engine.progress}%`), bar, button('Cancel', () => post({ type: 'cancelInstall' })));
    } else if (loaded && engine.state === 'error') {
      parts.push(paragraphOf(engine.message || 'The voice could not start.'), button('Try again', () => post({ type: 'retry' }), true),
        engine.kind === 'system' ? button('Use natural voice', () => post({ type: 'useNatural' })) : button('Use system voice', () => post({ type: 'useSystem' })));
    }
    $('setup').replaceChildren(...parts);
    $('setup').hidden = !parts.length;
    $('setup').classList.toggle('error', engine.state === 'error');
    $('stale').hidden = !(loaded && stale);
    $('refresh').hidden = selection;
    $('stale-text').textContent = selection ? 'The file changed. Read the selection again to hear the changes.' : 'The file changed.';
  }

  function renderSettings() {
    $('table-mode').value = settings.tableMode;
    $('code-blocks').value = settings.codeBlocks;
    $('words').checked = settings.highlightWords;
    $('follow').checked = settings.followInEditor;
    const back = settings.skipBack;
    const forward = settings.skipForward;
    $('back').title = `Back ${back} seconds (← or J)`;
    $('back').setAttribute('aria-label', `Back ${back} seconds`);
    $('forward').title = `Forward ${forward} seconds (→ or L)`;
    $('forward').setAttribute('aria-label', `Forward ${forward} seconds`);
    for (const [id, value] of [['back', back], ['forward', forward]]) {
      const label = $(id).querySelector('text');
      if (label) label.textContent = String(value);
    }
  }

  function unlock() {
    if (unlocked) return;
    unlocked = true;
    for (const player of players) {
      if (!player.el.paused) continue;
      const empty = !player.el.getAttribute('src');
      if (empty) player.el.src = SILENT;
      // Calling play() during a click or key press is what unlocks an element; pausing at once keeps it silent.
      const attempt = player.el.play();
      if (!empty) player.el.pause();
      attempt.then(() => {
        if (player.el.getAttribute('src') === SILENT) player.el.pause();
        event('unlocked');
      }, failure => {
        if (failure && failure.name === 'NotAllowedError') unlocked = false;
        else event('unlocked');
      });
    }
  }

  function needGesture() {
    unlocked = false;
    $('start').hidden = false;
    $('start-button').focus();
    event('needs-gesture', true);
  }

  function onPlan(message) {
    resetAudio();
    once.clear();
    revision = message.revision;
    loaded = true;
    utterances = message.utterances;
    blocks = message.blocks;
    settings = message.settings;
    selection = !!message.selection;
    spokenChars = 0;
    spokenSeconds = 0;
    const start = message.start;
    index = clamp(start.index, 0, Math.max(0, utterances.length - 1));
    word = -1;
    pendingOffset = start.offset || 0;
    pendingWord = start.word >= 0 ? { index, word: start.word } : null;
    autoplay = !!start.autoplay;
    playing = false;
    waiting = false;
    finished = false;
    stale = false;
    error = '';
    setRate(settings.rate, false);
    syncVolume(settings.volume);
    renderSettings();
    if (navigator.mediaSession && typeof MediaMetadata === 'function') {
      navigator.mediaSession.metadata = new MediaMetadata({ title: message.title || 'Markdown', artist: 'Clear Markdown Reader' });
    }
    rebuildTimeline();
    renderSetup();
    updateControls();
    updateTime();
    report(true);
  }

  function onIdle() {
    resetAudio();
    loaded = false;
    utterances = [];
    blocks = [];
    playing = false;
    waiting = false;
    finished = false;
    autoplay = false;
    stale = false;
    error = '';
    index = 0;
    word = -1;
    pendingOffset = 0;
    pendingWord = null;
    rebuildTimeline();
    renderSetup();
    updateControls();
    updateTime();
  }

  function onEngine(message) {
    if (message.revision !== revision) {
      // A new voice or narration: keep the place, but none of the old audio.
      const offset = offsetNow();
      resetAudio();
      revision = message.revision;
      pendingOffset = offset;
      spokenChars = 0;
      spokenSeconds = 0;
    }
    engine = message;
    renderVoices();
    renderSetup();
    if (engine.state === 'ready' && loaded) {
      error = '';
      rebuildTimeline();
      if (autoplay || playing) {
        autoplay = false;
        go(index, pendingOffset, true);
      } else requestNeeded();
    } else if (engine.state !== 'loading' && playing) pause();
    updateControls();
    updateTime();
  }

  function onSettings(message) {
    Object.assign(settings, message);
    // Ignore the echo of a speed the listener is still changing.
    if (!rateTimer && Math.abs(message.rate - rate) > 0.001) setRate(message.rate, false);
    syncVolume(message.volume);
    renderSettings();
    updateTime();
  }

  function onCommand(message) {
    const actions = {
      togglePlay: toggle, play, pause, stop: pause,
      skipBack: () => seekTo(now() - settings.skipBack), skipForward: () => seekTo(now() + settings.skipForward),
      previousSentence: () => sentence(-1), nextSentence: () => sentence(1),
      previousParagraph: () => paragraph(-1), nextParagraph: () => paragraph(1),
      faster: () => stepRate(1), slower: () => stepRate(-1),
      setRate: () => setRate(message.value),
      top: () => go(0, 0, true),
      seek: () => goWord(Number(message.index) || 0, Number(message.word ?? -1), message.play ?? playing)
    };
    if (!loaded && message.action !== 'togglePlay' && message.action !== 'play') return;
    actions[message.action]?.();
  }

  document.addEventListener('pointerdown', unlock, true);
  document.addEventListener('keydown', keyEvent => {
    if (!keyEvent.repeat && !['Escape', 'Tab', 'Shift', 'Control', 'Alt', 'Meta'].includes(keyEvent.key)) unlock();
  }, true);
  $('start-button').addEventListener('click', () => {
    $('start').hidden = true;
    play();
  });

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
  $('rate').addEventListener('change', () => setRate($('rate').value));
  $('more').addEventListener('click', () => {
    const open = $('settings').hidden;
    $('settings').hidden = !open;
    $('more').setAttribute('aria-expanded', String(open));
  });
  $('voice').addEventListener('change', () => post({ type: 'setting', key: 'voice', value: $('voice').value }));
  $('table-mode').addEventListener('change', () => post({ type: 'setting', key: 'tableMode', value: $('table-mode').value }));
  $('code-blocks').addEventListener('change', () => post({ type: 'setting', key: 'codeBlocks', value: $('code-blocks').value }));
  $('words').addEventListener('change', () => post({ type: 'setting', key: 'highlightWords', value: $('words').checked }));
  $('follow').addEventListener('change', () => post({ type: 'setting', key: 'followInEditor', value: $('follow').checked }));
  $('engine-switch').addEventListener('click', () => post({ type: engine.kind === 'system' ? 'useNatural' : 'useSystem' }));
  $('refresh').addEventListener('click', () => post({ type: 'refresh' }));

  const slider = $('volume');
  const volumeAt = pointer => {
    const rect = $('volume-track').getBoundingClientRect();
    if (rect.height > 0) setVolume(((rect.bottom - pointer.clientY) / rect.height) * 100);
  };
  slider.addEventListener('pointerdown', pointer => {
    if (pointer.button) return;
    draggingVolume = true;
    try {
      slider.setPointerCapture?.(pointer.pointerId);
    } catch {
      // Without capture the drag still works while the pointer stays over the slider.
    }
    pointer.preventDefault();
    slider.focus();
    volumeAt(pointer);
  });
  slider.addEventListener('pointermove', pointer => {
    if (draggingVolume) volumeAt(pointer);
  });
  for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) slider.addEventListener(name, () => { draggingVolume = false; });
  slider.addEventListener('keydown', keyEvent => {
    const steps = { ArrowUp: 5, ArrowRight: 5, ArrowDown: -5, ArrowLeft: -5, PageUp: 20, PageDown: -20 };
    if (keyEvent.key in steps) stepVolume(steps[keyEvent.key]);
    else if (keyEvent.key === 'Home') setVolume(0);
    else if (keyEvent.key === 'End') setVolume(100);
    else return;
    keyEvent.preventDefault();
    keyEvent.stopPropagation();
  });
  slider.parentElement.addEventListener('wheel', wheelEvent => {
    if (!wheelEvent.deltaY) return;
    wheelEvent.preventDefault();
    stepVolume(wheelEvent.deltaY < 0 ? 5 : -5);
  }, { passive: false });
  $('mute').addEventListener('click', toggleMute);

  document.addEventListener('keydown', keyEvent => {
    const target = keyEvent.target;
    if (keyEvent.key === 'Escape') {
      $('settings').hidden = true;
      $('more').setAttribute('aria-expanded', 'false');
      return;
    }
    if (target instanceof Element && target.closest('select, textarea, input:not([type=range]):not([type=checkbox]), #settings')) return;
    if (keyEvent.ctrlKey || keyEvent.metaKey || keyEvent.altKey) return;
    const onButton = target instanceof Element && target.closest('button');
    const back = () => seekTo(now() - settings.skipBack);
    const forward = () => seekTo(now() + settings.skipForward);
    const actions = {
      ' ': () => (onButton ? false : toggle()),
      k: toggle, K: toggle, j: back, J: back, l: forward, L: forward,
      ArrowLeft: () => (keyEvent.shiftKey ? sentence(-1) : back()),
      ArrowRight: () => (keyEvent.shiftKey ? sentence(1) : forward()),
      ArrowUp: () => (keyEvent.shiftKey ? paragraph(-1) : stepVolume(5)),
      ArrowDown: () => (keyEvent.shiftKey ? paragraph(1) : stepVolume(-5)),
      m: toggleMute, M: toggleMute,
      ',': () => sentence(-1), '.': () => sentence(1),
      '[': () => paragraph(-1), ']': () => paragraph(1),
      '-': () => stepRate(-1), _: () => stepRate(-1), '=': () => stepRate(1), '+': () => stepRate(1),
      Home: () => go(0, 0)
    };
    const action = actions[keyEvent.key];
    if (!action || !loaded) return;
    if (action() === false) return;
    keyEvent.preventDefault();
  });

  // Audio sent while the view was hidden may not have arrived; ask again when it is shown.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    lastNeed = '';
    requestNeeded();
    updateTime();
  });

  // Lets keyboard and headset media keys control reading where the platform supports it.
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
      case 'idle': onIdle(); break;
      case 'engine': onEngine(data); break;
      case 'audio': onAudio(data); break;
      case 'settings': onSettings(data); break;
      case 'command': onCommand(data); break;
      case 'stale':
        stale = !!data.value;
        renderSetup();
        break;
      case 'error':
        if (data.revision !== undefined && data.revision !== revision) return;
        if (data.index === undefined || data.index === index) {
          error = data.message;
          if (playing && waiting) {
            playing = false;
            waiting = false;
            playToken++;
            stopTicking();
          }
        }
        updateControls();
        report(true);
        break;
    }
  });

  applyVolume();
  renderVolume();
  updateControls();
  updateTime();
  post({ type: 'ready' });
})();
