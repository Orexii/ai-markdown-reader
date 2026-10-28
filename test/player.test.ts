import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

function player() {
  // Use the extension's real HTML body, not an independently maintained test layout.
  const source = readFileSync('src/extension.ts', 'utf8');
  const body = source.match(/<body>([\s\S]*?)<\/body>/)?.[1];
  assert.ok(body);
  const dom = new JSDOM(`<body>${body.replace(/<script[\s\S]*?<\/script>/, '')}</body>`, { runScripts: 'outside-only' });
  const { window } = dom;
  const messages: { type: string; request?: number; index?: number }[] = [];
  let playCount = 0;
  window.HTMLMediaElement.prototype.play = async () => { playCount++; };
  window.HTMLMediaElement.prototype.pause = () => undefined;
  window.HTMLMediaElement.prototype.load = () => undefined;
  Object.assign(window, { acquireVsCodeApi: () => ({ postMessage: (message: typeof messages[number]) => messages.push(message) }) });
  window.eval(readFileSync('media/reader.js', 'utf8'));
  const receive = (data: object) => window.dispatchEvent(new window.MessageEvent('message', { data }));
  const click = (id: string) => {
    const element = window.document.getElementById(id);
    assert.ok(element);
    (element as HTMLElement).click();
  };
  receive({
    type: 'plan', revision: 1, voice: '', voices: [], rate: 1, tableMode: 'rows',
    segments: [{ text: 'First passage.', line: 0 }, { text: 'Second passage.', line: 1 }], ai: false
  });
  return { dom, window, messages, receive, click, playCount: () => playCount };
}

test('play, pause while generating, resume, advance and stop work', () => {
  const p = player();
  try {
    p.click('play');
    const pending = p.messages.at(-1)!;
    assert.equal(pending.type, 'audio');
    p.click('play');
    p.receive({ type: 'audio', index: 0, request: pending.request, revision: 1, uri: 'https://local/one.wav' });
    assert.equal(p.playCount(), 0, 'pausing while speech is generated must prevent autoplay');
    p.click('play');
    assert.equal(p.playCount(), 1);
    p.window.document.getElementById('audio')!.dispatchEvent(new p.window.Event('ended'));
    assert.equal(p.messages.at(-1)!.index, 1);
    p.click('stop');
    assert.match(p.window.document.getElementById('status')!.textContent!, /passage 1 of 2/);
    assert.equal(p.window.document.getElementById('audio')!.getAttribute('src'), null);
  } finally { p.dom.window.close(); }
});

test('stale audio responses after skipping or stopping never play', () => {
  const p = player();
  try {
    p.click('play');
    const first = p.messages.at(-1)!;
    p.click('next');
    p.receive({ type: 'audio', index: 0, request: first.request, revision: 1, uri: 'https://local/stale.wav' });
    assert.equal(p.playCount(), 0);
    p.receive({ type: 'error', request: first.request, message: 'A stale generation failed.' });
    assert.equal(p.window.document.getElementById('error')!.hidden, true);
    const next = p.messages.at(-1)!;
    p.click('stop');
    p.receive({ type: 'audio', index: 1, request: next.request, revision: 1, uri: 'https://local/stale.wav' });
    assert.equal(p.playCount(), 0);
  } finally { p.dom.window.close(); }
});

test('document content is inert text, including AI proposals', () => {
  const p = player();
  try {
    const attack = '<img src=x onerror=alert(1)>';
    p.receive({ type: 'plan', revision: 2, voices: [], voice: '', rate: 1, segments: [{ text: attack }], ai: false });
    p.receive({ type: 'proposal', original: [{ text: 'Original.' }], segments: [{ text: attack }] });
    assert.equal(p.window.document.querySelectorAll('img').length, 0);
    assert.equal(p.window.document.getElementById('after')!.textContent, attack);
    assert.equal(p.playCount(), 0, 'AI proposals are never automatically spoken');
    p.click('apply');
    assert.equal(p.messages.at(-1)!.type, 'applyAI');
  } finally { p.dom.window.close(); }
});

test('AI cancellation, errors, discard and source navigation stay usable', () => {
  const p = player();
  try {
    p.click('ai');
    assert.equal(p.window.document.getElementById('ai')!.hasAttribute('disabled'), true);
    p.receive({ type: 'aiDone' });
    assert.equal(p.window.document.getElementById('ai')!.hasAttribute('disabled'), false);
    p.receive({ type: 'error', message: 'No Copilot models are available.' });
    assert.match(p.window.document.getElementById('error')!.textContent!, /No Copilot/);
    p.window.document.querySelector<HTMLButtonElement>('.source')!.click();
    assert.equal(p.messages.at(-1)!.type, 'reveal');
    p.click('discard');
    assert.equal(p.messages.at(-1)!.type, 'discardAI');
  } finally { p.dom.window.close(); }
});

test('custom configured playback speed is supported', () => {
  const p = player();
  try {
    p.receive({ type: 'plan', revision: 2, voices: [], voice: '', rate: 1.1, segments: [{ text: 'Text.' }], ai: false });
    assert.equal(p.window.document.querySelector<HTMLSelectElement>('#rate')!.value, '1.1');
    assert.equal(p.window.document.querySelector<HTMLAudioElement>('#audio')!.playbackRate, 1.1);
  } finally { p.dom.window.close(); }
});

test('stopping while audio.play is pending does not display a spurious playback error', async () => {
  const p = player();
  try {
    p.window.HTMLMediaElement.prototype.play = () => Promise.reject(new Error('The play request was interrupted by a pause.'));
    p.click('play');
    const pending = p.messages.at(-1)!;
    p.receive({ type: 'audio', index: 0, request: pending.request, revision: 1, uri: 'https://local/one.wav' });
    p.click('stop');
    await Promise.resolve();
    assert.equal(p.window.document.getElementById('error')!.hidden, true);
  } finally { p.dom.window.close(); }
});
