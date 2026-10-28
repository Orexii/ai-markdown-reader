import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { renderPreview } from '../src/preview';
import { buildDocument } from '../src/document';

const SAMPLE = [
  '# Kusto access',
  '',
  'First **bold** sentence here. Second [linked](https://example.com) sentence.',
  '',
  '| Name | State |',
  '| --- | --- |',
  '| Mail | Ready |',
  '',
  '```js',
  'run();',
  '```'
].join('\n');

type Posted = { type: string; [key: string]: unknown };

function preview(markdown = SAMPLE) {
  const dom = new JSDOM(`<!doctype html><html><body><main id="content">${renderPreview(markdown)}</main><button id="back-to-reading" hidden></button></body></html>`,
    { runScripts: 'outside-only', pretendToBeVisual: true });
  const window = dom.window as unknown as Window & typeof globalThis & { eval(code: string): unknown };
  const posted: Posted[] = [];
  const scrolls: unknown[] = [];
  window.matchMedia = ((query: string) => ({ matches: query.includes('reduce'), addEventListener() {}, removeEventListener() {} })) as never;
  window.scrollTo = ((options: unknown) => { scrolls.push(options); }) as never;
  window.scrollBy = (() => undefined) as never;
  Object.assign(window, { acquireVsCodeApi: () => ({ postMessage: (message: Posted) => posted.push(JSON.parse(JSON.stringify(message)) as Posted) }) });
  window.eval(readFileSync('media/preview.js', 'utf8'));
  const send = (data: object) => window.dispatchEvent(new window.MessageEvent('message', { data }));
  const doc = buildDocument(markdown);
  const show = (index: number, word = -1) => {
    const utterance = doc.utterances[index]!;
    send({ type: 'position', position: { uri: 'file:///x.md', sentence: utterance.range, word: word >= 0 ? utterance.words[word]!.range : null } });
  };
  const $$ = (selector: string) => [...window.document.querySelectorAll<HTMLElement>(selector)];
  const last = (type: string) => posted.filter(message => message.type === type).at(-1);
  return { window, dom, doc, posted, scrolls, send, show, $$, last };
}

test('the sentence and the spoken word are highlighted, and the state is reported', () => {
  const p = preview();
  p.send({ type: 'settings', settings: { follow: true, words: true } });
  assert.deepEqual(p.last('ready'), { type: 'ready' });
  p.show(1, 1);
  // jsdom has no CSS Custom Highlight API, so the fallback marks each word of the sentence.
  assert.deepEqual(p.$$('.cmr-sentence').map(element => element.textContent), ['First', 'bold', 'sentence', 'here.']);
  assert.deepEqual(p.$$('.cmr-word').map(element => element.textContent), ['bold']);
  assert.deepEqual(p.last('state'), { type: 'state', sentence: 'First bold sentence here.', word: 'bold', following: true });
  p.show(2, 1);
  assert.deepEqual(p.$$('.cmr-word').map(element => element.textContent), ['linked']);
  assert.equal(p.$$('.cmr-sentence')[0]!.textContent, 'Second');
  p.send({ type: 'clear' });
  assert.equal(p.$$('.cmr-sentence, .cmr-word, .cmr-block').length, 0);
});

test('table rows and code blocks are highlighted as blocks; word highlighting can be turned off', () => {
  const p = preview();
  const row = p.doc.utterances.findIndex(u => u.line === 6);
  p.show(row, p.doc.utterances[row]!.words.findIndex(w => w.text === 'Ready'));
  assert.deepEqual(p.$$('.cmr-block').map(element => element.tagName), ['TR']);
  assert.equal(p.$$('.cmr-block')[0]!.getAttribute('data-line'), '6');
  assert.deepEqual(p.$$('.cmr-word').map(element => element.textContent), ['Ready']);
  p.show(0);
  const header = p.doc.utterances.findIndex(u => u.words.some(w => w.text === 'Columns'));
  p.show(header, p.doc.utterances[header]!.words.findIndex(w => w.text === 'State'));
  assert.equal(p.$$('.cmr-block')[0]!.closest('thead') !== null, true, 'the column names light up in the header row');
  assert.deepEqual(p.$$('.cmr-word').map(element => element.textContent), ['State']);
  p.show(p.doc.utterances.length - 1);
  assert.deepEqual(p.$$('.cmr-block').map(element => element.tagName), ['PRE']);
  p.send({ type: 'settings', settings: { follow: true, words: false } });
  p.show(1, 1);
  assert.equal(p.$$('.cmr-word').length, 0);
});

test('double-clicking a word asks to read from it; right-click remembers it; links open', () => {
  const p = preview();
  const word = p.$$('.w').find(element => element.textContent === 'sentence')!;
  word.dispatchEvent(new p.window.MouseEvent('dblclick', { bubbles: true }));
  assert.deepEqual(p.last('readFrom'), { type: 'readFrom', line: 2, character: SAMPLE.split('\n')[2]!.indexOf('sentence') });
  word.dispatchEvent(new p.window.MouseEvent('contextmenu', { bubbles: true }));
  assert.equal(p.last('contextTarget')!.line, 2);
  const code = p.window.document.querySelector('pre')!;
  code.dispatchEvent(new p.window.MouseEvent('dblclick', { bubbles: true }));
  assert.deepEqual(p.last('readFrom'), { type: 'readFrom', line: 8, character: 0 });
  p.window.document.querySelector('a')!.dispatchEvent(new p.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  assert.deepEqual(p.last('openLink'), { type: 'openLink', href: 'https://example.com' });
});

test('the preview follows the reading until the listener scrolls away, then offers Back to reading', async () => {
  const p = preview();
  p.send({ type: 'settings', settings: { follow: true, words: true } });
  Object.defineProperty(p.window, 'innerHeight', { configurable: true, value: 600 });
  const place = (top: number) => {
    for (const element of p.$$('.w, [data-line]')) element.getBoundingClientRect = () => ({ top, bottom: top + 20, width: 50, height: 20, left: 0, right: 50, x: 0, y: top, toJSON() {} });
  };
  place(900);
  p.show(1);
  assert.equal(p.scrolls.length, 1, 'scrolls to a sentence below the view');
  await new Promise(resolve => setTimeout(resolve, 1600));
  place(-400);
  p.window.dispatchEvent(new p.window.Event('scroll'));
  const pill = p.window.document.getElementById('back-to-reading')!;
  assert.equal(pill.hidden, false);
  assert.match(pill.textContent!, /↑ Back to reading/);
  p.show(2);
  assert.equal(p.scrolls.length, 1, 'does not pull the view back while the listener looks elsewhere');
  pill.click();
  assert.equal(p.scrolls.length, 2);
  assert.equal(pill.hidden, true);
});

test('an edit re-renders the document and keeps the highlight', () => {
  const p = preview();
  p.show(1, 0);
  const edited = SAMPLE.replace('# Kusto access', '# Kusto access, updated');
  p.send({ type: 'render', html: renderPreview(edited) });
  assert.equal(p.window.document.querySelector('h1')!.textContent, 'Kusto access, updated');
  assert.deepEqual(p.$$('.cmr-word').map(element => element.textContent), ['First']);
});

test('while its file is read, the preview sends the player keys; scrolling keys are left alone', () => {
  const p = preview();
  const press = (key: string, init: KeyboardEventInit = {}) => {
    const event = new p.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
    p.window.document.body.dispatchEvent(event);
    return event.defaultPrevented;
  };
  const commands = () => p.posted.filter(message => message.type === 'command').map(message => message.action);
  assert.equal(press('ArrowRight'), false, 'nothing is read yet');
  assert.deepEqual(commands(), []);
  p.show(1, 0);
  assert.equal(press('ArrowRight'), true);
  press('ArrowLeft');
  press('ArrowRight', { shiftKey: true });
  press('ArrowLeft', { shiftKey: true });
  press('ArrowRight', { ctrlKey: true });
  press('ArrowLeft', { ctrlKey: true });
  press('ArrowDown', { shiftKey: true });
  press('k');
  press('+');
  assert.deepEqual(commands(), ['nextParagraph', 'previousParagraph', 'nextSentence', 'previousSentence', 'skipForward', 'skipBack', 'nextSection', 'togglePlay', 'faster']);
  for (const key of ['ArrowDown', 'ArrowUp', ' ', 'PageDown']) assert.equal(press(key), false, `${key} still scrolls`);
  assert.equal(press('ArrowLeft', { altKey: true }), false, 'Alt+← is left to VS Code (Go Back)');
  assert.equal(commands().length, 9);
});
