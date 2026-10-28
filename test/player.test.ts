import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { playerMarkup } from '../src/markup';
import { buildDocument } from '../src/document';
import { planMessage, type PlanSettings, type PlanStart } from '../src/plan';

const SAMPLE = [
  '# Heading',
  'First sentence here. Second sentence follows.',
  '- A list item to read.',
  '| Name | State |\n| --- | --- |\n| Mail | Ready |',
  'Read more at [the docs](https://example.com/docs).'
].join('\n\n');

type Posted = { type: string; [key: string]: unknown };
const FORMAT = { sampleRate: 8000, channels: 1, bits: 16, blockAlign: 2 };

function player(markdown = SAMPLE, overrides: Partial<PlanSettings> = {}) {
  const markup = playerMarkup({ cspSource: 'vscode-resource:', nonce: 'n', css: 'player.css', script: 'player.js', skipBack: 10, skipForward: 30 });
  const body = /<body>([\s\S]*)<\/body>/.exec(markup)![1]!.replace(/<script[\s\S]*?<\/script>/, '');
  const dom = new JSDOM(`<!doctype html><html><body>${body}</body></html>`, { runScripts: 'outside-only', pretendToBeVisual: true });
  const window = dom.window as unknown as Window & typeof globalThis & { eval(code: string): unknown };
  const posted: Posted[] = [];
  const control = { reject: '' };
  const started: HTMLAudioElement[] = [];
  const media = window.HTMLMediaElement.prototype;
  const times = new WeakMap<object, number>();
  const paused = new WeakMap<object, boolean>();
  Object.defineProperty(media, 'currentTime', { configurable: true, get() { return times.get(this) ?? 0; }, set(value: number) { times.set(this, value); } });
  Object.defineProperty(media, 'paused', { configurable: true, get() { return paused.get(this) ?? true; } });
  // The first object URL is the player's silent unlock clip.
  media.play = async function (this: HTMLMediaElement) {
    if (control.reject && this.getAttribute('src') !== 'blob:audio-1') {
      const name = control.reject;
      control.reject = '';
      throw Object.assign(new Error('blocked'), { name });
    }
    paused.set(this, false);
    if (this.getAttribute('src') !== 'blob:audio-1') started.push(this as HTMLAudioElement);
    setTimeout(() => this.dispatchEvent(new window.Event('playing')));
  };
  media.pause = function (this: HTMLMediaElement) { paused.set(this, true); };
  media.load = function () {};
  let urls = 0;
  window.URL.createObjectURL = () => `blob:audio-${++urls}`;
  window.URL.revokeObjectURL = () => undefined;
  const audios: HTMLAudioElement[] = [];
  const Original = window.Audio;
  window.Audio = function () {
    const element = new Original();
    audios.push(element);
    return element;
  } as never;
  Object.assign(window, { acquireVsCodeApi: () => ({ postMessage: (message: Posted) => posted.push(JSON.parse(JSON.stringify(message, (_, v) => (v instanceof window.Uint8Array ? `bytes:${v.length}` : v))) as Posted) }) });
  window.eval(readFileSync('media/player.js', 'utf8'));
  const doc = buildDocument(markdown);
  const settings: PlanSettings = { rate: 1, followInEditor: true, highlightWords: true, skipBack: 10, skipForward: 30, tableMode: 'rows', codeBlocks: 'announce', ...overrides };
  const send = (data: object) => window.dispatchEvent(new window.MessageEvent('message', { data }));
  const $ = (id: string) => window.document.getElementById(id)!;
  const click = (id: string) => ($(id) as HTMLElement).click();
  const key = (key: string, init: KeyboardEventInit = {}) => window.document.body.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true, ...init }));
  const wait = (ms = 70) => new Promise(resolve => setTimeout(resolve, ms));
  /** Sends `duration` seconds of audio for a passage, with evenly spaced word timings. */
  const audioFor = (index: number, duration = 2, revision = 0) => {
    const words = doc.utterances[index]!.words.length;
    const times = Array.from({ length: words }, (_, k) => [k * (duration / (words + 1)), (k + 1) * (duration / (words + 1))]).flat();
    send({ type: 'audio', revision, index, pcm: new window.Uint8Array(Math.round(duration * FORMAT.sampleRate) * 2), format: FORMAT, times });
  };
  const plan = (start: Partial<PlanStart> = {}, revision = 0) =>
    send(planMessage(doc, revision, { index: 0, offset: 0, word: -1, autoplay: false, ...start }, settings, 'sample.md', false));
  const ready = (revision = 0, state = 'ready') => send({ type: 'engine', revision, state, kind: 'natural', voices: [{ id: 'af_heart', label: 'Heart' }], voice: 'af_heart', sizeMB: 326, progress: 40 });
  const last = (type: string) => posted.filter(message => message.type === type).at(-1);
  const events = () => posted.filter(message => message.type === 'event').map(message => message.event as string);
  const position = () => last('position')!;
  /** The element that most recently started playing, and therefore holds the current track. */
  const current = () => started.at(-1)!;
  const timeupdate = (element: HTMLAudioElement) => element.dispatchEvent(new window.Event('timeupdate'));
  const close = async () => {
    await wait(20);
    dom.window.close();
  };
  return { window, doc, posted, send, $, click, key, wait, audioFor, plan, ready, last, events, position, current, timeupdate, control, close, audios, started };
}

test('play waits for audio, then joins passages into one track and reports sentence and word', async () => {
  const p = player();
  try {
    p.plan();
    p.ready();
    assert.deepEqual((p.last('need')!.indices as number[]).slice(0, 3), [0, 1, 2]);
    assert.equal(p.last('need')!.ahead, 0);
    p.click('play');
    assert.match(p.$('status').textContent!, /Preparing audio/);
    assert.equal(p.started.length, 0);
    p.audioFor(0, 2);
    assert.equal(p.started.length, 1);
    const first = p.current();
    p.audioFor(1, 3);
    assert.equal(p.started.length, 1, 'a passage arriving later does not interrupt playback');
    await p.wait();
    assert.ok(p.events().includes('playing'));
    first.currentTime = 1.6;
    p.timeupdate(first);
    assert.equal(p.position().index, 0);
    assert.equal(p.position().word, 0, 'the heading word is being spoken');
    assert.equal(p.position().playing, true);
    // The next passage was prepared in the other player because this track ends within seconds.
    const next = p.audios.find(audio => audio !== first)!;
    assert.match(next.getAttribute('src')!, /^blob:audio-/);
    assert.equal(next.paused, true);
  } finally {
    await p.close();
  }
});

test('cached passages play as one continuous track with no element switch between sentences', async () => {
  const p = player();
  try {
    p.plan();
    p.ready();
    p.audioFor(0, 2);
    p.audioFor(1, 3);
    p.audioFor(2, 2);
    p.click('play');
    const element = p.current();
    element.currentTime = 2.5;
    p.timeupdate(element);
    assert.equal(p.position().index, 1, 'crossed into the second sentence inside the same track');
    assert.equal(p.position().word, 0);
    element.currentTime = 4.2;
    p.timeupdate(element);
    assert.ok((p.position().word as number) >= 2, 'the word follows the audio clock');
    element.currentTime = 5.2;
    p.timeupdate(element);
    assert.equal(p.position().index, 2);
    assert.equal(p.started.length, 1, 'no new element was started');
  } finally {
    await p.close();
  }
});

test('the next track starts just before the current one ends, inside its closing pause', async () => {
  const p = player();
  try {
    p.plan();
    p.ready();
    p.audioFor(0, 2);
    p.click('play');
    p.audioFor(1, 2);
    const first = p.current();
    first.currentTime = 1.98;
    p.timeupdate(first);
    await p.wait(30);
    assert.equal(p.started.length, 2, 'started without waiting for the ended event');
    const second = p.current();
    assert.notEqual(second, first);
    assert.equal(second.currentTime, 0);
    assert.equal(p.position().index, 1);
    await p.wait(20);
    assert.ok(p.events().some(event => /^gap -?\d+$/.test(event)), 'the handoff reports its timing');
    first.dispatchEvent(new p.window.Event('ended'));
    assert.equal(p.position().index, 1, 'the old track ending later is ignored');
  } finally {
    await p.close();
  }
});

test('a passage that is not ready yet is a reported stall, and playback resumes when it arrives', async () => {
  const p = player();
  try {
    p.plan();
    p.ready();
    p.audioFor(0, 1);
    p.click('play');
    p.current().dispatchEvent(new p.window.Event('ended'));
    assert.ok(p.events().includes('stall 1'));
    assert.match(p.$('status').textContent!, /Preparing audio/);
    assert.equal(p.position().waiting, true);
    p.audioFor(1, 2);
    assert.equal(p.started.length, 2);
    assert.equal(p.position().index, 1);
    assert.equal(p.position().waiting, false);
    assert.ok(p.events().some(event => event.startsWith('stall-end')));
  } finally {
    await p.close();
  }
});

test('the last passage finishes and Play starts again from the top', async () => {
  const p = player('One.');
  try {
    p.plan();
    p.ready();
    p.audioFor(0, 1);
    p.click('play');
    p.current().dispatchEvent(new p.window.Event('ended'));
    assert.match(p.$('status').textContent!, /Finished/);
    assert.ok(p.events().includes('finished'));
    p.click('play');
    assert.equal(p.current().currentTime, 0);
    assert.equal(p.position().playing, true);
  } finally {
    await p.close();
  }
});

test('time skips cross passages using real and estimated durations', async () => {
  const p = player(SAMPLE, { skipBack: 1.5, skipForward: 2 });
  try {
    p.plan();
    p.ready();
    p.audioFor(0, 2);
    p.audioFor(1, 3);
    p.click('play');
    const element = p.current();
    element.currentTime = 1;
    p.click('forward');
    assert.equal(p.position().index, 1);
    assert.ok(Math.abs(element.currentTime - 3) < 1e-9, 'lands 1 s into the second passage, in the same track');
    element.currentTime = 2.5;
    p.timeupdate(element);
    p.click('back');
    assert.equal(p.position().index, 0);
    assert.ok(Math.abs(element.currentTime - 1) < 1e-9);
    const length = Number((p.$('seek') as HTMLInputElement).max);
    assert.ok(length > 5, 'unsynthesized passages contribute estimated time');
    assert.match(p.$('remaining').textContent!, /^~\d+:\d\d left$/);
    (p.$('seek') as HTMLInputElement).value = String(length + 100);
    p.$('seek').dispatchEvent(new p.window.Event('change'));
    const lastIndex = p.doc.utterances.length - 1;
    assert.equal(p.position().index, lastIndex);
    assert.equal((p.last('need')!.indices as number[])[0], lastIndex);
  } finally {
    await p.close();
  }
});

test('sentence and paragraph navigation from buttons and keys', async () => {
  const p = player();
  try {
    p.plan();
    p.ready();
    const at = () => p.position().index;
    p.click('next');
    assert.equal(at(), 1);
    p.key('ArrowRight', { shiftKey: true });
    assert.equal(at(), 2);
    p.key('ArrowLeft', { shiftKey: true });
    assert.equal(at(), 1);
    p.key('ArrowDown', { shiftKey: true });
    const nextBlock = p.doc.utterances.findIndex(u => u.block > p.doc.utterances[1]!.block);
    assert.equal(at(), nextBlock);
    p.key('ArrowUp', { shiftKey: true });
    assert.equal(at(), 1, 'back to the start of the previous paragraph');
    p.key('Home');
    assert.equal(at(), 0);
    assert.equal(p.$('section').textContent, 'Heading');
  } finally {
    await p.close();
  }
});

test('host commands seek to a word, and Play with nothing loaded asks to read the open file', async () => {
  const p = player();
  try {
    p.click('play');
    assert.deepEqual(p.last('readActive'), { type: 'readActive' });
    assert.equal(p.$('idle').hidden, false);
    p.plan();
    p.ready();
    assert.equal(p.$('idle').hidden, true);
    p.send({ type: 'command', action: 'seek', index: 2, word: 1, play: true });
    assert.equal((p.last('need')!.indices as number[])[0], 2);
    p.audioFor(2, 4);
    const words = p.doc.utterances[2]!.words.length;
    assert.ok(Math.abs(p.current().currentTime - (4 / (words + 1) - 0.05)) < 1e-9, 'playback starts at the requested word');
    p.send({ type: 'command', action: 'pause' });
    assert.equal(p.position().playing, false);
    p.send({ type: 'idle' });
    assert.equal(p.$('idle').hidden, false);
    assert.equal(p.current().paused, true);
  } finally {
    await p.close();
  }
});

test('audio from an old voice or narration is ignored, and a new revision keeps the place', async () => {
  const p = player();
  try {
    p.plan();
    p.ready();
    p.click('play');
    p.audioFor(0, 2, 7);
    assert.equal(p.started.length, 0, 'stale revision ignored');
    p.audioFor(0, 2);
    assert.equal(p.started.length, 1);
    p.ready(1);
    assert.ok(p.audios.every(audio => audio.getAttribute('src') === null || audio.paused), 'old audio stopped for the new voice');
    assert.equal(p.last('need')!.revision, 1);
    assert.equal((p.last('need')!.indices as number[])[0], 0);
    p.audioFor(0, 2, 1);
    assert.equal(p.started.length, 2, 'keeps playing with the new voice');
  } finally {
    await p.close();
  }
});

test('setup banner offers the download, shows progress and recovers from errors; edits offer an update', async () => {
  const p = player();
  try {
    p.plan();
    p.ready(0, 'missing');
    assert.match(p.$('setup').textContent!, /326 MB/);
    assert.equal((p.$('play') as HTMLButtonElement).disabled, true);
    [...p.$('setup').querySelectorAll('button')].find(b => /Download/.test(b.textContent!))!.click();
    assert.deepEqual(p.last('install'), { type: 'install' });
    p.ready(0, 'downloading');
    assert.equal((p.$('setup').querySelector('progress') as HTMLProgressElement).value, 40);
    p.ready(0, 'error');
    [...p.$('setup').querySelectorAll('button')].find(b => /Try again/.test(b.textContent!))!.click();
    assert.deepEqual(p.last('retry'), { type: 'retry' });
    p.ready(0, 'ready');
    assert.equal(p.$('setup').hidden, true);
    p.send({ type: 'stale', value: true });
    assert.equal(p.$('stale').hidden, false);
    p.click('refresh');
    assert.deepEqual(p.last('refresh'), { type: 'refresh' });
  } finally {
    await p.close();
  }
});

test('speeds are quarter steps from 0.5x to 2x, pitch is preserved, and the choice is saved', async () => {
  const p = player();
  try {
    p.plan();
    p.ready();
    const options = [...(p.$('rate') as HTMLSelectElement).options].map(option => option.textContent);
    assert.deepEqual(options, ['0.5×', '0.75×', '1×', '1.25×', '1.5×', '1.75×', '2×']);
    (p.$('rate') as HTMLSelectElement).value = '1.5';
    p.$('rate').dispatchEvent(new p.window.Event('change'));
    assert.ok(p.audios.every(audio => audio.playbackRate === 1.5 && audio.preservesPitch === true));
    p.key('+');
    p.key('+');
    p.key('+');
    assert.equal(p.audios[0]!.playbackRate, 2, 'stops at double speed');
    p.key('-');
    p.key('-');
    p.key('-');
    assert.equal(p.audios[0]!.playbackRate, 1.25);
    assert.equal((p.$('rate') as HTMLSelectElement).value, '1.25');
    p.send({ type: 'command', action: 'setRate', value: 0.9 });
    assert.equal(p.audios[0]!.playbackRate, 1, 'other values snap to the nearest step');
    await p.wait(350);
    assert.deepEqual(p.last('setting'), { type: 'setting', key: 'rate', value: 1 });
  } finally {
    await p.close();
  }
});

test('keyboard shortcuts play and skip, but never steal typing', async () => {
  const p = player();
  try {
    p.plan();
    p.ready();
    p.audioFor(0, 2);
    p.key(' ');
    assert.equal(p.position().playing, true);
    assert.equal(p.current().paused, false);
    assert.match(p.$('play').getAttribute('aria-label')!, /Pause/);
    p.key('k');
    assert.match(p.$('play').getAttribute('aria-label')!, /Play/);
    p.$('voice').dispatchEvent(new p.window.KeyboardEvent('keydown', { key: 'k', bubbles: true }));
    assert.match(p.$('play').getAttribute('aria-label')!, /Play/);
    p.key('l');
    assert.equal(p.position().index, p.doc.utterances.length - 1, 'forward 30 s from the start reaches the end of this short sample');
  } finally {
    await p.close();
  }
});

test('when VS Code blocks sound, Start appears and one click unlocks both players', async () => {
  const p = player();
  try {
    p.plan({ autoplay: true });
    p.audioFor(0, 2);
    p.control.reject = 'NotAllowedError';
    p.ready();
    await p.wait(10);
    assert.ok(p.events().includes('needs-gesture'));
    assert.equal(p.$('start').hidden, false);
    assert.equal(p.position().playing, false);
    p.$('start-button').dispatchEvent(new p.window.Event('pointerdown', { bubbles: true }));
    p.click('start-button');
    await p.wait(10);
    assert.equal(p.$('start').hidden, true);
    assert.equal(p.position().playing, true);
    assert.ok(p.events().includes('unlocked'));
    assert.ok(p.audios.every(audio => audio.getAttribute('src') !== null), 'both players were unlocked during the click');
  } finally {
    await p.close();
  }
});

test('settings controls report changes to the extension', async () => {
  const p = player();
  try {
    p.plan();
    p.ready();
    assert.equal(p.$('settings').hidden, true);
    p.click('more');
    assert.equal(p.$('settings').hidden, false);
    (p.$('table-mode') as HTMLSelectElement).value = 'columns';
    p.$('table-mode').dispatchEvent(new p.window.Event('change'));
    assert.deepEqual(p.last('setting'), { type: 'setting', key: 'tableMode', value: 'columns' });
    (p.$('follow') as HTMLInputElement).click();
    assert.deepEqual(p.last('setting'), { type: 'setting', key: 'followInEditor', value: false });
    p.click('engine-switch');
    assert.deepEqual(p.last('useSystem'), { type: 'useSystem' });
    p.send({ type: 'settings', rate: 1.75, highlightWords: false, followInEditor: true, skipBack: 5, skipForward: 15, tableMode: 'rows', codeBlocks: 'announce' });
    assert.equal(p.audios[0]!.playbackRate, 1.75);
    assert.equal((p.$('words') as HTMLInputElement).checked, false);
    assert.equal(p.$('back').getAttribute('aria-label'), 'Back 5 seconds');
  } finally {
    await p.close();
  }
});
