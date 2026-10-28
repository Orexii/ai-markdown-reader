import MarkdownIt from 'markdown-it';
import type Token from 'markdown-it/lib/token.mjs';
import { Source, cellColumn, locateCell, locateParagraph, stripFrontMatter, textFinder, type Locator } from './document';

export interface PreviewOptions {
  /** Turns an image path from the document into a URL the preview can load, or undefined to drop it. */
  resolveImage?(src: string): string | undefined;
}

interface WordMark { start: number; end: number; line: number; character: number }

const md = new MarkdownIt({ html: true, linkify: true });
const escape = md.utils.escapeHtml;
const ALERTS: Record<string, string> = { NOTE: 'Note', TIP: 'Tip', IMPORTANT: 'Important', WARNING: 'Warning', CAUTION: 'Caution' };

const position = (line: number, character: number) => `${line},${character}`;

/** GitHub-style heading ids, so in-document links such as [Setup](#setup) work. */
function slugify(text: string): string {
  return text.trim().toLowerCase()
    .replace(/[\]\[!/'"#$%&()*+,./:;<=>?@\\^{|}~`。，、；：？！…—·ˉ¨‘’“”々～‖∶＂＇｀｜〃〔〕〈〉《》「」『』．〖〗【】（）［］｛｝]/g, '')
    .replace(/\s+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Records where each rendered word of an inline token sits in the source, for highlighting. */
function markWords(inline: Token, locator: Locator, content: string): void {
  const find = textFinder(content);
  let cursor = 0;
  const locate = (text: string): { line: number; character: number } | null => {
    const found = text ? find(text, cursor) : null;
    if (!found) return null;
    cursor = found[1];
    return locator.at(found[0]);
  };
  for (const child of inline.children ?? []) {
    if (child.type === 'text') {
      const words: WordMark[] = [];
      for (const match of child.content.matchAll(/\S+/g)) {
        const at = locate(match[0]);
        if (at) words.push({ start: match.index!, end: match.index! + match[0].length, ...at });
      }
      child.meta = { ...child.meta, words };
    } else if (child.type === 'code_inline' || child.type === 'image') {
      const at = locate(child.content);
      if (at) child.meta = { ...child.meta, at };
    }
  }
}

/** An inline HTML token, for markup the preview adds (checkboxes and alert titles). */
function htmlToken(content: string): Token {
  const token = new md.core.State.prototype.Token('html_inline', '', 0);
  token.content = content;
  return token;
}

/** Renders task-list markers as checkboxes and GitHub alerts with a title, like VS Code's preview. */
function decorate(tokens: Token[]): void {
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    const inline = tokens[i + 1]?.type === 'paragraph_open' ? tokens[i + 2] : undefined;
    const first = inline?.children?.[0];
    if (token.type === 'list_item_open' && first?.type === 'text') {
      const task = /^\[([ xX])\]\s+/.exec(first.content);
      if (task) {
        token.attrJoin('class', 'task-list-item');
        first.content = first.content.slice(task[0].length);
        inline!.children!.unshift(htmlToken(`<input type="checkbox" class="task-list-item-checkbox" disabled${task[1] !== ' ' ? ' checked' : ''}> `));
      }
    }
    if (token.type === 'blockquote_open' && first?.type === 'text') {
      const alert = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*$/i.exec(first.content);
      if (alert) {
        const kind = alert[1]!.toUpperCase();
        token.attrJoin('class', `alert alert-${kind.toLowerCase()}`);
        inline!.children!.splice(0, inline!.children![1]?.type === 'softbreak' ? 2 : 1, htmlToken(`<span class="alert-title">${ALERTS[kind]}</span>`));
      }
    }
  }
}

function annotate(tokens: Token[], source: Source): void {
  const slugs = new Map<string, number>();
  let row = { line: 0, cursor: 0 };
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.map && token.nesting >= 0 && token.type !== 'inline' && token.type !== 'html_block') {
      token.attrSet('data-line', String(token.map[0]));
    }
    if (token.type === 'tr_open') row = { line: token.map?.[0] ?? row.line, cursor: 0 };
    if (token.type === 'heading_open') {
      const text = (tokens[i + 1]?.children ?? []).filter(child => child.type === 'text' || child.type === 'code_inline').map(child => child.content).join('');
      const base = slugify(text) || 'section';
      const count = slugs.get(base) ?? 0;
      slugs.set(base, count + 1);
      token.attrSet('id', count ? `${base}-${count}` : base);
    }
    if (token.type !== 'inline') continue;
    const opener = tokens[i - 1];
    if (opener?.type === 'th_open' || opener?.type === 'td_open') {
      const { column, raw } = cellColumn(source.lines[row.line] ?? '', token.content, row.cursor);
      if (column >= 0) row.cursor = column + raw.length;
      markWords(token, locateCell(row.line, column), raw);
    } else if (token.map) {
      markWords(token, locateParagraph(token.content, token.map[0], source), token.content);
    }
  }
}

const rules = md.renderer.rules;
rules.text = (tokens, idx) => {
  const token = tokens[idx]!;
  const words = (token.meta?.words ?? []) as WordMark[];
  let html = '';
  let at = 0;
  for (const word of words) {
    html += escape(token.content.slice(at, word.start));
    html += `<span class="w" data-p="${position(word.line, word.character)}">${escape(token.content.slice(word.start, word.end))}</span>`;
    at = word.end;
  }
  return html + escape(token.content.slice(at));
};
rules.code_inline = (tokens, idx, _options, _env, self) => {
  const token = tokens[idx]!;
  const at = token.meta?.at as { line: number; character: number } | undefined;
  if (at) {
    token.attrJoin('class', 'w');
    token.attrSet('data-p', position(at.line, at.character));
  }
  return `<code${self.renderAttrs(token)}>${escape(token.content)}</code>`;
};
const image = rules.image!;
rules.image = (tokens, idx, options, env, self) => {
  const token = tokens[idx]!;
  const src = token.attrGet('src') ?? '';
  const resolve = (env as { resolveImage?: PreviewOptions['resolveImage'] }).resolveImage;
  const resolved = resolve ? resolve(src) : src;
  if (resolved === undefined) token.attrs = (token.attrs ?? []).filter(([name]) => name !== 'src');
  else token.attrSet('src', resolved);
  const html = image(tokens, idx, options, env, self);
  const at = token.meta?.at as { line: number; character: number } | undefined;
  return at ? `<span class="w" data-p="${position(at.line, at.character)}">${html}</span>` : html;
};

/**
 * Renders Markdown much as VS Code's preview does, with every word tagged with its source position
 * (data-p="line,character") and every block with its first line (data-line), so the reading
 * position can be highlighted.
 */
export function renderPreview(markdown: string, options: PreviewOptions = {}): string {
  const text = stripFrontMatter(markdown);
  const env = { resolveImage: options.resolveImage };
  const tokens = md.parse(text, env);
  decorate(tokens);
  annotate(tokens, new Source(text, 0, 0));
  return md.renderer.render(tokens, md.options, env);
}
