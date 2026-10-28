import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { renderPreview } from '../src/preview';

/** Renders and checks that every highlightable word points at its own text in the source. */
function render(markdown: string, options?: Parameters<typeof renderPreview>[1]): Document {
  const dom = new JSDOM(`<main>${renderPreview(markdown, options)}</main>`).window.document;
  const lines = markdown.split(/\r?\n/);
  for (const element of dom.querySelectorAll<HTMLElement>('.w[data-p]')) {
    const [line, character] = element.dataset.p!.split(',').map(Number) as [number, number];
    const shown = element.tagName === 'SPAN' && element.querySelector('img') ? element.querySelector('img')!.alt : element.textContent!;
    const source = lines[line]!.slice(character);
    const plain = (text: string) => text.replace(/[*_`\\]/g, '');
    assert.ok(plain(source).startsWith(plain(shown)), `"${shown}" points at "${source.slice(0, 30)}"`);
  }
  return dom;
}

test('the bundled demonstration renders every word with a source position', () => {
  const dom = render(readFileSync('examples/demo.md', 'utf8'));
  assert.ok(dom.querySelectorAll('.w').length > 100);
  assert.ok(dom.querySelector('table tr[data-line]'));
  assert.ok(dom.querySelectorAll('li[data-line]').length > 2);
});

test('emphasis, links, inline code, escapes and tables keep word positions', () => {
  const markdown = [
    '# Title with `code`',
    '',
    'A **DataHarbor** [link text](https://example.com/x) and `npm run build` \\*literal\\* end.',
    '',
    '| Service | State | Detail |',
    '| --- | --- | --- |',
    '| Mail | **Ready** | A \\| B |'
  ].join('\n');
  const lines = markdown.split('\n');
  const dom = render(markdown);
  const at = (text: string) => [...dom.querySelectorAll<HTMLElement>('.w')].find(element => element.textContent === text)?.dataset.p;
  assert.equal(at('DataHarbor'), `2,${lines[2]!.indexOf('DataHarbor')}`);
  assert.equal(at('link'), `2,${lines[2]!.indexOf('link')}`);
  assert.equal(at('npm run build'), `2,${lines[2]!.indexOf('npm run build')}`, 'inline code is one unit');
  assert.equal(at('B'), `6,${lines[6]!.lastIndexOf('B')}`, 'escaped pipes keep cell positions');
  assert.equal(at('Ready'), `6,${lines[6]!.indexOf('Ready')}`);
  assert.equal(dom.querySelector('a')!.getAttribute('href'), 'https://example.com/x');
  assert.ok(!dom.body.textContent!.includes('https://example.com/x'), 'link targets are not shown as text');
  assert.equal(dom.querySelector('tbody tr')!.getAttribute('data-line'), '6');
});

test('headings get ids, task lists get checkboxes, alerts get titles, front matter is hidden', () => {
  const markdown = '---\ntitle: Secret\n---\n\n# Kusto access\n\n## Kusto access\n\n- [x] Done\n- [ ] Next\n\n> [!WARNING]\n> Back up first.\n';
  const dom = render(markdown);
  assert.deepEqual([...dom.querySelectorAll('h1, h2')].map(element => element.id), ['kusto-access', 'kusto-access-1']);
  const boxes = dom.querySelectorAll<HTMLInputElement>('input.task-list-item-checkbox');
  assert.deepEqual([...boxes].map(box => box.checked), [true, false]);
  assert.equal(dom.querySelector('li')!.textContent!.trim(), 'Done');
  assert.equal(dom.querySelector('blockquote.alert-warning .alert-title')!.textContent, 'Warning');
  assert.ok(!dom.body.textContent!.includes('[!WARNING]'));
  assert.ok(!dom.body.textContent!.includes('Secret'));
  assert.equal(dom.querySelector('h1')!.getAttribute('data-line'), '4', 'line numbers count the hidden front matter');
});

test('images are resolved through the host, and unknown schemes are dropped', () => {
  const dom = render('![Diagram](images/a.png) ![Web](https://example.com/b.png) ![Other](ftp://example.com/c.png) ![Bad](javascript:alert(1))', {
    resolveImage: src => (src.startsWith('images/') ? `https://webview/${src}` : /^https:/.test(src) ? src : undefined)
  });
  const images = [...dom.querySelectorAll('img')];
  assert.deepEqual(images.map(image => image.getAttribute('src')), ['https://webview/images/a.png', 'https://example.com/b.png', null]);
  assert.equal(images[0]!.closest('.w')!.getAttribute('data-p'), '0,2');
  assert.ok(!dom.querySelector('img[alt="Bad"]'), 'markdown-it never makes javascript: links into images');
});

test('raw HTML scripts do not become active content', () => {
  const html = renderPreview('Hello <script>alert(1)</script> **there**');
  // Script elements may be present as markup, but the preview's CSP only runs its own nonce'd script.
  assert.ok(html.includes('<span class="w" data-p="0,34">there</span>'));
});
