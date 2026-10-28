import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { readerMarkup } from '../src/markup';
import { buildDocument } from '../src/document';
import { planMessage, type PlanSettings } from '../src/plan';

const SAMPLE = [
  '# Heading',
  'First sentence here. Second sentence follows.',
  '- A list item to read.',
  '| Name | State |\n| --- | --- |\n| Mail | Ready |',
  'Read more at [the docs](https://example.com/docs).'
].join('\n\n');

type Posted = { type: string; [key: string]: unknown };

function player(markdown = SAMPLE, overrides: Partial<PlanSettings> = {}) {
  const markup = readerMarkup({ cspSource: 'vscode-resource:', nonce: 'n', css: 'reader.css', script: 'reader.js', skipBack: 10, skipForward: 30 });
  const body = /<body>([\s\S]*)<\/body>/.exec(markup)![1]!.replace(/<script[\s\S]*?<\/script>/, '');
  const dom = new JSDOM(`<!doctype html><html><body>${body}</body></html>`, { runScripts: 'outside-only', pretendToBeVisual: true });
  const window = dom.window as unknown as Window & typeof globalThis & { eval(code: string): unknown };
  const posted: Posted[] = [];
  const scrolls: unknown[] = [];
  let plays = 0;
  const control = { reject: '' as string, silentPlays: 0 };
  const media = window.HTMLMediaElement.prototype;
  const times = new WeakMap<object, number>();
  const paused = new WeakMap<object, boolean>();
  Object.defineProperty(media, 'currentTime', { configurable: true, get() { return times.get(this) ?? 0; }, set(value: number) { times.set(this, value); } });
  Object.defineProperty(media, 'paused', { configurable: true, get() { return paused.get(this) ?? true; } });
  // The first object URL is the reader's silent unlock clip.
  media.play = async function (this: HTMLMediaElement) {
    if (this.getAttribute('src') === 'blob:audio-1') {
      control.silentPlays++;
      return;
    }
    if (control.reject) {
      const name = control.reject;
      control.reject = '';
      throw Object.assign(new Error('blocked'), { name });
    }
    plays++;
    paused.set(this, false);
  };
  media.pause = function (this: HTMLMediaElement) { paused.set(this, true); };
  media.load = function () {};
  let urls = 0;
  window.URL.createObjectURL = () => `blob:audio-${++urls}`;
  window.URL.revokeObjectURL = () => undefined;
  window.matchMedia = ((query: string) => ({ matches: query.includes('reduce'), addEventListener() {}, removeEventListener() {} })) as never;
  window.scrollTo = ((options: unknown) => { scrolls.push(options); }) as never;
  let audio!: HTMLAudioElement;
  const Original = window.Audio;
  window.Audio = function () { audio = new Original(); return audio; } as never;
  Object.assign(window, { acquireVsCodeApi: () => ({ postMessage: (message: Posted) => posted.push(JSON.parse(JSON.stringify(message)) as Posted) }) });
  window.eval(readFileSync('media/reader.js', 'utf8'));
  const doc = buildDocument(markdown);
  const settings: PlanSettings = { rate: 1, followInEditor: true, highlightWords: true, skipBack: 10, skipForward: 30, tableMode: 'rows', codeBlocks: 'announce', selection: false, ...overrides };
  const send = (data: object) => window.dispatchEvent(new window.MessageEvent('message', { data }));
  const $ = (id: string) => window.document.getElementById(id)!;
  const click = (id: string) => ($(id) as HTMLElement).click();
  const key = (key: string, init: KeyboardEventInit = {}) => window.document.body.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true, ...init }));
  const frame = () => new Promise(resolve => setTimeout(resolve, 40));
  const audioFor = (index: number, duration = 2, revision = 0) => {
    const words = doc.utterances[index]!.words.length;
    const wordTimes = Array.from({ length: words }, (_, k) => [k * (duration / (words + 1)), (k + 1) * (duration / (words + 1))]).flat();
    send({ type: 'audio', revision, index, wav: new window.Uint8Array(16), duration, wordTimes });
  };
  const plan = (start = { index: 0, offset: 0, autoplay: false }, revision = 0) => send(planMessage(doc, revision, start, settings));
  const ready = (revision = 0, state = 'ready') => send({ type: 'engine', revision, state, kind: 'natural', voices: [{ id: 'af_heart', label: 'Heart' }], voice: 'af_heart', sizeMB: 326, progress: 40 });
  const last = (type: string) => posted.filter(message => message.type === type).at(-1);
  // Let pending play() promises settle before the window goes away.
  const close = async () => {
    await new Promise(resolve => setTimeout(resolve, 20));
    dom.window.close();
  };
  return { dom, window, doc, posted, scrolls, send, $, click, key, frame, audioFor, plan, ready, last, control, close, plays: () => plays, audio: () => audio };
}

test('play waits for audio, then plays and highlights the sentence and the spoken word', async () => {
  const p = player();
  try {
    p.plan();
    p.ready();
    assert.deepEqual((p.last('need')!.indices as number[]).slice(0, 3), [0, 1, 2]);
    const first = p.doc.utterances[0]!;
    assert.ok(p.$(first.highlight[0]!).classList.contains('reading'));
    p.click('play');
    assert.match(p.$('status').textContent!, /Preparing audio/);
    assert.equal(p.plays(), 0);
    p.audioFor(0, 2);
    assert.equal(p.plays(), 1);
    assert.match(p.audio().src, /^blob:audio-/);
    await p.frame();
    assert.ok(p.posted.some(message => message.type === 'event' && message.event === 'playing'));
    const second = p.doc.utterances[1]!;
    p.audioFor(1, 3);
    p.audio().dispatchEvent(new p.window.Event('ended'));
    assert.ok(p.$(second.highlight[0]!).classList.contains('reading'));
    assert.ok(!p.$(first.highlight[0]!).classList.contains('reading'));
    p.audio().currentTime = 1.6;
    await p.frame();
    const spokenWord = second.words[2]!.target!;
    assert.ok(p.$(spokenWord).classList.contains('reading-word'), 'word highlight follows the audio clock');
    assert.equal(p.window.document.querySelectorAll('.reading-word').length, 1);
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
    p.audio().dispatchEvent(new p.window.Event('ended'));
    assert.match(p.$('status').textContent!, /Finished/);
    assert.ok(p.posted.some(message => message.type === 'event' && message.event === 'finished'));
    p.click('play');
    assert.equal(p.audio().currentTime, 0);
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
    p.audio().currentTime = 1;
    p.click('forward');
    assert.ok(p.$(p.doc.utterances[1]!.highlight[0]!).classList.contains('reading'));
    assert.ok(Math.abs(p.audio().currentTime - 1) < 1e-9, 'lands 1 s into the second passage');
    p.audio().currentTime = 0.5;
    p.click('back');
    assert.ok(p.$(p.doc.utterances[0]!.highlight[0]!).classList.contains('reading'));
    assert.ok(Math.abs(p.audio().currentTime - 1) < 1e-9);
    const length = Number((p.$('seek') as HTMLInputElement).max);
    assert.ok(length > 5, 'unsynthesized passages contribute estimated time');
    assert.match(p.$('remaining').textContent!, /^~\d+:\d\d left$/);
    (p.$('seek') as HTMLInputElement).value = String(length + 100);
    p.$('seek').dispatchEvent(new p.window.Event('change'));
    const lastIndex = p.doc.utterances.length - 1;
    assert.ok(p.$(p.doc.utterances[lastIndex]!.highlight[0]!).classList.contains('reading'));
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
    const at = (index: number) => p.$(p.doc.utterances[index]!.highlight[0]!).classList.contains('reading');
    p.click('next');
    assert.ok(at(1));
    p.key('ArrowRight', { shiftKey: true });
    assert.ok(at(2));
    p.key('ArrowLeft', { shiftKey: true });
    assert.ok(at(1));
    p.key('ArrowDown', { shiftKey: true });
    const nextBlock = p.doc.utterances.findIndex(u => u.block > p.doc.utterances[1]!.block);
    assert.ok(at(nextBlock));
    p.key('ArrowUp', { shiftKey: true });
    assert.ok(at(1), 'back to the start of the previous paragraph');
    p.key('Home');
    assert.ok(at(0));
  } finally {
    await p.close();
  }
});

test('clicking a word reads from it; Alt+Click reveals the source; Ctrl+Click opens links', async () => {
  const p = player();
  try {
    p.plan();
    p.ready();
    const target = p.doc.utterances[2]!;
    const word = p.$(target.words[1]!.target!);
    word.dispatchEvent(new p.window.MouseEvent('click', { bubbles: true }));
    assert.equal((p.last('need')!.indices as number[])[0], 2);
    p.audioFor(2, 4);
    const start = 4 / (target.words.length + 1) - 0.05;
    assert.ok(Math.abs(p.audio().currentTime - start) < 1e-9, 'playback starts at the clicked word');
    assert.equal(p.plays() > 0, true);
    word.dispatchEvent(new p.window.MouseEvent('click', { bubbles: true, altKey: true }));
    assert.deepEqual(p.last('reveal'), { type: 'reveal', index: 2 });
    const link = p.window.document.querySelector('.link')!;
    link.dispatchEvent(new p.window.MouseEvent('click', { bubbles: true, ctrlKey: true }));
    assert.deepEqual(p.last('openLink'), { type: 'openLink', href: 'https://example.com/docs' });
  } finally {
    await p.close();
  }
});

test('audio from an old voice or narration is ignored, and a new revision starts over', async () => {
  const p = player();
  try {
    p.plan();
    p.ready();
    p.click('play');
    p.audioFor(0, 2, 7);
    assert.equal(p.plays(), 0, 'stale revision ignored');
    p.audioFor(0, 2);
    assert.equal(p.plays(), 1);
    p.ready(1);
    assert.equal(p.audio().getAttribute('src'), null, 'cache cleared for the new voice');
    assert.deepEqual(p.last('need'), { type: 'need', revision: 1, indices: (p.last('need')!.indices as number[]) });
    assert.equal((p.last('need')!.indices as number[])[0], 0);
    p.audioFor(0, 2, 1);
    assert.equal(p.plays(), 2, 'keeps playing with the new voice');
  } finally {
    await p.close();
  }
});

test('setup banner offers the download, shows progress and recovers from errors', async () => {
  const p = player();
  try {
    p.plan();
    p.ready(0, 'missing');
    assert.match(p.$('banner').textContent!, /326 MB/);
    assert.equal((p.$('play') as HTMLButtonElement).disabled, true);
    [...p.$('banner').querySelectorAll('button')].find(b => /Download/.test(b.textContent!))!.click();
    assert.deepEqual(p.last('install'), { type: 'install' });
    p.ready(0, 'downloading');
    assert.equal((p.$('banner').querySelector('progress') as HTMLProgressElement).value, 40);
    p.ready(0, 'error');
    [...p.$('banner').querySelectorAll('button')].find(b => /Try again/.test(b.textContent!))!.click();
    assert.deepEqual(p.last('retry'), { type: 'retry' });
    p.ready(0, 'ready');
    assert.equal(p.$('banner').hidden, true);
    p.send({ type: 'stale' });
    [...p.$('banner').querySelectorAll('button')].find(b => /Refresh/.test(b.textContent!))!.click();
    assert.deepEqual(p.last('refresh'), { type: 'refresh' });
  } finally {
    await p.close();
  }
});

test('speed menu and keys change the rate with pitch preserved, and persist it', async () => {
  const p = player();
  try {
    p.plan();
    p.ready();
    p.click('rate');
    assert.equal(p.$('speed-menu').hidden, false);
    ([...p.$('speed-menu').querySelectorAll('button')].find(b => b.textContent === '1.5×') as HTMLButtonElement).click();
    assert.equal(p.audio().playbackRate, 1.5);
    assert.equal(p.audio().preservesPitch, true);
    assert.equal(p.$('rate').textContent, '1.5×');
    p.key('+');
    assert.equal(p.audio().playbackRate, 1.6);
    p.key('-');
    p.key('-');
    assert.equal(p.audio().playbackRate, 1.4);
    await new Promise(resolve => setTimeout(resolve, 450));
    assert.deepEqual(p.last('setting'), { type: 'setting', key: 'rate', value: 1.4 });
  } finally {
    await p.close();
  }
});

test('keyboard shortcuts play, skip and show help, but never steal typing', async () => {
  const p = player();
  try {
    p.plan();
    p.ready();
    p.audioFor(0, 2);
    p.key(' ');
    assert.equal(p.plays(), 1);
    assert.match(p.$('play').getAttribute('aria-label')!, /Pause/);
    p.key('k');
    assert.match(p.$('play').getAttribute('aria-label')!, /Play/);
    p.key('?');
    assert.equal(p.$('shortcuts').hidden, false);
    p.key('Escape');
    assert.equal(p.$('shortcuts').hidden, true);
    p.$('voice').dispatchEvent(new p.window.KeyboardEvent('keydown', { key: 'k', bubbles: true }));
    assert.match(p.$('play').getAttribute('aria-label')!, /Play/);
    p.key('l');
    assert.ok(p.$(p.doc.utterances.at(-1)!.highlight[0]!).classList.contains('reading'), 'forward 30 s from the start reaches the end of this short sample');
  } finally {
    await p.close();
  }
});

test('Copilot descriptions are reviewed before replacing a table narration', async () => {
  const p = player();
  try {
    p.plan();
    p.ready();
    const tableIndex = p.doc.blocks.findIndex(block => block.kind === 'table');
    const describe = p.window.document.querySelector('.describe') as HTMLButtonElement;
    assert.match(describe.textContent!, /Describe table/);
    describe.click();
    assert.deepEqual(p.last('describe'), { type: 'describe', block: tableIndex });
    assert.equal(describe.disabled, true);
    p.send({ type: 'description', block: tableIndex, text: 'Mail is ready.' });
    const box = p.window.document.querySelector('.describe-box')!;
    assert.match(box.textContent!, /Mail is ready\./);
    assert.equal(p.plays(), 0, 'nothing is spoken until the listener chooses');
    [...box.querySelectorAll('button')].find(b => /Read this instead/.test(b.textContent!))!.click();
    assert.deepEqual(p.last('useDescription'), { type: 'useDescription', block: tableIndex, text: 'Mail is ready.' });
    p.send({ type: 'description', block: tableIndex, error: 'No Copilot models are available.' });
    assert.match(p.window.document.querySelector('.describe-box')!.textContent!, /No Copilot models/);
    assert.equal(p.window.document.querySelectorAll('.describe-box').length, 1);
  } finally {
    await p.close();
  }
});

test('scrolling away pauses follow mode and Back to reading returns', async () => {
  const p = player();
  try {
    p.plan();
    p.ready();
    Object.defineProperty(p.window, 'innerHeight', { configurable: true, value: 800 });
    const sentence = p.$(p.doc.utterances[0]!.highlight[0]!);
    sentence.getBoundingClientRect = () => ({ top: 2000, bottom: 2030, width: 100, height: 30 } as DOMRect);
    await new Promise(resolve => setTimeout(resolve, 260));
    p.window.dispatchEvent(new p.window.Event('scroll'));
    const pill = p.$('back-to-reading');
    assert.equal(pill.hidden, false);
    assert.match(pill.textContent!, /↓ Back to reading/);
    const before = p.scrolls.length;
    pill.click();
    assert.equal(p.scrolls.length, before + 1);
    assert.equal(pill.hidden, true);
  } finally {
    await p.close();
  }
});

test('host commands and speech errors are handled', async () => {
  const p = player();
  try {
    p.plan();
    p.ready();
    p.send({ type: 'command', action: 'togglePlay' });
    assert.match(p.$('status').textContent!, /Preparing audio/);
    p.send({ type: 'error', revision: 0, index: 0, message: 'Speech failed: boom' });
    assert.match(p.$('status').textContent!, /Speech failed: boom/);
    assert.match(p.$('play').getAttribute('aria-label')!, /Play/);
    p.send({ type: 'command', action: 'nextSentence' });
    assert.ok(p.$(p.doc.utterances[1]!.highlight[0]!).classList.contains('reading'));
    assert.equal(p.$('status').textContent, 'Paused');
  } finally {
    await p.close();
  }
});

test('the first gesture unlocks audio with a silent clip that never advances the reader', async () => {
  const p = player();
  try {
    p.plan();
    p.ready();
    p.window.document.body.dispatchEvent(new p.window.MouseEvent('pointerdown', { bubbles: true }));
    assert.equal(p.control.silentPlays, 1);
    assert.equal(p.audio().getAttribute('src'), 'blob:audio-1');
    p.audio().dispatchEvent(new p.window.Event('ended'));
    assert.ok(p.$(p.doc.utterances[0]!.highlight[0]!).classList.contains('reading'), 'silent clip ending does not move on');
    p.window.document.body.dispatchEvent(new p.window.MouseEvent('pointerdown', { bubbles: true }));
    assert.equal(p.control.silentPlays, 1, 'unlock happens once');
    p.audioFor(0, 2);
    p.click('play');
    assert.equal(p.plays(), 1);
    assert.match(p.audio().getAttribute('src')!, /^blob:audio-[2-9]/);
  } finally {
    await p.close();
  }
});

test('when VS Code blocks sound, a focused Start listening button resumes playback', async () => {
  const p = player();
  try {
    p.plan({ index: 0, offset: 0, autoplay: true });
    p.control.reject = 'NotAllowedError';
    p.ready();
    p.audioFor(0, 2);
    await p.frame();
    assert.equal(p.$('start').hidden, false);
    assert.equal(p.window.document.activeElement, p.$('start-button'));
    assert.ok(p.posted.some(message => message.type === 'event' && message.event === 'needs-gesture'));
    assert.match(p.$('play').getAttribute('aria-label')!, /Play/);
    p.click('start-button');
    await p.frame();
    assert.equal(p.plays(), 1);
    assert.equal(p.$('start').hidden, true);
    assert.ok(p.posted.some(message => message.type === 'event' && message.event === 'playing'));
  } finally {
    await p.close();
  }
});
