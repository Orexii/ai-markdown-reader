import MarkdownIt from 'markdown-it';
import type Token from 'markdown-it/lib/token.mjs';

export type BlockKind = 'heading' | 'paragraph' | 'item' | 'table' | 'code' | 'html';

export interface SpokenWord {
  /** Text to speak for this unit, before pronunciation rules. */
  text: string;
  /** Element highlighted while this unit is spoken; null for spoken-only cues. */
  target: string | null;
  /** Whitespace and punctuation spoken after the unit; shapes pauses and intonation. */
  sep: string;
}

export interface Utterance {
  block: number;
  /** Elements highlighted for the whole utterance: sentence spans, a table row or a code block. */
  highlight: string[];
  words: SpokenWord[];
  /** Total silence after this utterance, in seconds at 1x. */
  pauseAfter: number;
  line: number;
  endLine: number;
}

export interface ReaderBlock {
  kind: BlockKind;
  id: string;
  line: number;
  endLine: number;
  /** First utterance index, or -1 for blocks that are shown but not spoken. */
  first: number;
  heading?: { level: number; text: string };
}

export interface ReaderDocument {
  html: string;
  utterances: Utterance[];
  blocks: ReaderBlock[];
}

export interface DocumentOptions {
  tableMode: 'rows' | 'columns';
  codeBlocks: 'announce' | 'read' | 'skip';
  lineOffset: number;
  /** Approved replacement narration (for example from Copilot), keyed by block index. */
  overrides?: ReadonlyMap<number, string>;
}

const defaults: DocumentOptions = { tableMode: 'rows', codeBlocks: 'announce', lineOffset: 0 };
const parser = new MarkdownIt({ html: true, linkify: false });
const sentenceSegmenter = new Intl.Segmenter('en', { granularity: 'sentence' });

/** Utterances above these spoken lengths are split, preferring clause boundaries. */
const SOFT_LIMIT = 200;
const HARD_LIMIT = 280;

export const PAUSE = { clause: 0.15, sentence: 0.3, heading: 0.75, paragraph: 0.6, item: 0.45, row: 0.45, code: 0.6, rule: 0.9 };

const ALERTS: Record<string, string> = { NOTE: 'Note', TIP: 'Tip', IMPORTANT: 'Important', WARNING: 'Warning', CAUTION: 'Caution' };
const ABBREVIATIONS = new Set(['e.g.', 'i.e.', 'etc.', 'vs.', 'approx.', 'cf.', 'mr.', 'mrs.', 'ms.', 'dr.', 'no.']);
const LEADING = /["'“‘([{«¿¡]/;
const TRAILING = /[.,;:!?"'”’)\]}»…]/;
const SPOKEN_SEPARATOR = /[;:,.!?—…"“”()]/g;
const SPEAKABLE_SYMBOLS = /^(?:&|\+|=|%|\$|#|@|<|>|→|->|<-|=>|×|~|≈|±|\/)$/;
const LANGUAGES: Record<string, string> = {
  ts: 'TypeScript', typescript: 'TypeScript', tsx: 'TypeScript', js: 'JavaScript', javascript: 'JavaScript',
  jsx: 'JavaScript', py: 'Python', python: 'Python', sh: 'shell', bash: 'shell', zsh: 'shell', shell: 'shell',
  console: 'shell', ps1: 'PowerShell', powershell: 'PowerShell', pwsh: 'PowerShell', kql: 'Kusto query',
  kusto: 'Kusto query', json: 'JSON', jsonc: 'JSON', yaml: 'YAML', yml: 'YAML', md: 'Markdown',
  markdown: 'Markdown', cs: 'C sharp', csharp: 'C sharp', bicep: 'Bicep', sql: 'SQL', html: 'HTML',
  css: 'CSS', go: 'Go', rust: 'Rust', rs: 'Rust', java: 'Java', cpp: 'C plus plus', c: 'C', xml: 'XML',
  mermaid: 'diagram', diff: 'diff', text: 'text', txt: 'text', ini: 'configuration', toml: 'TOML'
};

export function utteranceText(utterance: Utterance): string {
  return utterance.words.map(word => word.text + word.sep).join('').trim();
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]!));
}

function normalizeSeparator(text: string, final: boolean): string {
  const marks = (text.replace(/(^|\s)[–-]+(?=\s|$)/g, '$1—').match(SPOKEN_SEPARATOR) ?? []).join('');
  if (final) return /[.!?]/.test(marks) ? marks : `${marks.replace(/[,;:—]+$/, '')}.`;
  return marks ? `${marks} ` : ' ';
}

function spokenForm(text: string): string {
  let value = text.replace(/\p{Extended_Pictographic}|\uFE0F|\u200D/gu, '').replace(/\s+/g, ' ').trim();
  if (/^(?:https?:\/\/|www\.)\S+$/i.test(value)) {
    try { value = new URL(value.startsWith('www.') ? `https://${value}` : value).hostname.replace(/^www\./, ''); } catch { /* keep text */ }
  }
  return value;
}

function stripFrontMatter(markdown: string): string {
  // Replace YAML front matter with blank lines so source line numbers stay correct.
  return markdown.replace(/^---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)(?:\r?\n|$)/, match =>
    '\n'.repeat((match.match(/\n/g) ?? []).length));
}

interface Run { text: string; cls: string[]; href?: string; spoken?: string; atomic?: boolean; br?: boolean; parts?: boolean }
/** A highlightable unit; `parts` lists the spoken words when one unit (inline code) holds several. */
interface Unit { start: number; end: number; spoken: string; parts?: string[] }
interface Inline { display: string; owner: number[]; runs: Run[]; units: Unit[] }

function collectRuns(children: Token[]): Run[] {
  const runs: Run[] = [];
  const classes: string[] = [];
  let href: string | undefined;
  let autolink = false;
  const remove = (name: string) => {
    const index = classes.lastIndexOf(name);
    if (index >= 0) classes.splice(index, 1);
  };
  for (const child of children) {
    switch (child.type) {
      case 'text':
        if (!child.content) break;
        if (autolink) runs.push({ text: child.content, cls: [...classes], href, spoken: spokenForm(child.content), atomic: true });
        else runs.push({ text: child.content, cls: [...classes], href });
        break;
      // Inline code stays one highlighted chip even when it contains several words.
      case 'code_inline': runs.push({ text: child.content, cls: [...classes, 'code'], href, atomic: true, parts: true }); break;
      case 'softbreak': runs.push({ text: ' ', cls: [] }); break;
      case 'hardbreak': runs.push({ text: ' ', cls: [], br: true }); break;
      case 'html_inline':
        if (/^<br\s*\/?>$/i.test(child.content)) runs.push({ text: ' ', cls: [], br: true });
        break;
      case 'image': {
        const alt = child.content.replace(/\s+/g, ' ').trim();
        runs.push({ text: alt || 'image', cls: ['img'], spoken: alt ? `Image: ${alt}` : 'Image', atomic: true });
        break;
      }
      case 'strong_open': classes.push('strong'); break;
      case 'strong_close': remove('strong'); break;
      case 'em_open': classes.push('em'); break;
      case 'em_close': remove('em'); break;
      case 's_open': classes.push('del'); break;
      case 's_close': remove('del'); break;
      case 'link_open': {
        const target = child.attrGet('href') ?? '';
        href = /^(?:https?:|mailto:)/i.test(target) ? target : undefined;
        autolink = child.markup === 'autolink';
        classes.push('link');
        break;
      }
      case 'link_close': remove('link'); href = undefined; autolink = false; break;
    }
  }
  return runs;
}

function tokenize(runs: Run[]): Inline {
  let display = '';
  const owner: number[] = [];
  runs.forEach((run, index) => {
    display += run.text;
    for (let k = 0; k < run.text.length; k++) owner.push(index);
  });
  const units: Unit[] = [];
  let i = 0;
  while (i < display.length) {
    const run = runs[owner[i]!]!;
    if (run.atomic) {
      const start = i;
      while (i < display.length && owner[i] === owner[start]) i++;
      const text = display.slice(start, i);
      const parts = run.parts ? text.trim().split(/\s+/).map(spokenForm).filter(Boolean) : undefined;
      units.push({ start, end: i, spoken: run.spoken ?? (parts ? parts.join(' ') : text), parts: parts && parts.length > 1 ? parts : undefined });
      continue;
    }
    if (/\s/.test(display[i]!)) { i++; continue; }
    const start = i;
    while (i < display.length && !/\s/.test(display[i]!) && !runs[owner[i]!]!.atomic) i++;
    let s = start;
    let e = i;
    const token = display.slice(start, i);
    if (SPEAKABLE_SYMBOLS.test(token)) {
      units.push({ start, end: i, spoken: token });
      continue;
    }
    while (s < e && LEADING.test(display[s]!)) s++;
    if (!ABBREVIATIONS.has(display.slice(s, e).toLowerCase())) {
      while (e > s && TRAILING.test(display[e - 1]!)) e--;
    }
    if (s === e || /^[\p{P}\p{S}]+$/u.test(display.slice(s, e)) && !SPEAKABLE_SYMBOLS.test(display.slice(s, e))) continue;
    units.push({ start: s, end: e, spoken: spokenForm(display.slice(s, e)) });
  }
  return { display, owner, runs, units };
}

interface Range { start: number; end: number; units: number[] }

function sentences(inline: Inline): Range[] {
  const ranges: Range[] = [];
  let u = 0;
  for (const segment of sentenceSegmenter.segment(inline.display)) {
    const end = segment.index + segment.segment.length;
    const members: number[] = [];
    while (u < inline.units.length && inline.units[u]!.start < end) members.push(u++);
    const previous = ranges.at(-1);
    if (previous && segment.index < previous.end) {
      // The segmenter broke inside a unit (for example at "?" in a URL): keep one sentence.
      previous.units.push(...members);
      previous.end = Math.max(previous.end, end, ...members.map(u => inline.units[u]!.end));
    } else if (members.length) {
      ranges.push({ start: segment.index, end: Math.max(end, inline.units[members.at(-1)!]!.end), units: members });
    } else if (ranges.length) {
      ranges.at(-1)!.end = Math.max(ranges.at(-1)!.end, end);
    }
  }
  for (let k = 1; k < ranges.length; k++) {
    if (ranges[k]!.start < ranges[k - 1]!.end) ranges[k]!.start = ranges[k - 1]!.end;
  }
  if (ranges.length) {
    ranges[0]!.start = 0;
    ranges.at(-1)!.end = inline.display.length;
  }
  return ranges;
}

function pieces(inline: Inline, start: number, end: number): string {
  let html = '';
  let k = start;
  while (k < end) {
    const index = inline.owner[k]!;
    let stop = k;
    while (stop < end && inline.owner[stop] === index) stop++;
    const run = inline.runs[index]!;
    if (run.br) html += '<br>';
    else {
      const text = escapeHtml(inline.display.slice(k, stop));
      const attributes = run.href ? ` data-href="${escapeHtml(run.href)}" title="${escapeHtml(run.href)}"` : '';
      html += run.cls.length || attributes ? `<span class="${run.cls.join(' ')}"${attributes}>${text}</span>` : text;
    }
    k = stop;
  }
  return html;
}

class Builder {
  private readonly html: string[] = [];
  private readonly utterances: Utterance[] = [];
  private readonly blocks: ReaderBlock[] = [];
  private counter = 0;

  constructor(private readonly options: DocumentOptions) {}

  private id(prefix: string): string { return `${prefix}${this.counter++}`; }
  private line(map: [number, number] | null | undefined, fallback: number): [number, number] {
    const [start, end] = map ?? [fallback, fallback + 1];
    return [start + this.options.lineOffset, Math.max(start + 1, end) + this.options.lineOffset];
  }

  result(): ReaderDocument {
    return { html: this.html.join(''), utterances: this.utterances, blocks: this.blocks };
  }

  private addBlock(kind: BlockKind, id: string, lines: [number, number], heading?: ReaderBlock['heading']): number {
    this.blocks.push({ kind, id, line: lines[0], endLine: lines[1], first: -1, heading });
    return this.blocks.length - 1;
  }

  private addUtterances(block: number, groups: { highlight: string[]; words: SpokenWord[] }[], pause: number, lines: [number, number]): void {
    const spoken = groups.filter(group => group.words.some(word => word.text));
    spoken.forEach((group, index) => {
      const chunks = splitWords(group.words);
      chunks.forEach((chunk, k) => {
        if (this.blocks[block]!.first < 0) this.blocks[block]!.first = this.utterances.length;
        this.utterances.push({
          block, highlight: group.highlight, words: chunk, line: lines[0], endLine: lines[1],
          pauseAfter: k < chunks.length - 1 ? PAUSE.clause : PAUSE.sentence
        });
      });
      if (index === spoken.length - 1 && this.utterances.length) this.utterances.at(-1)!.pauseAfter = pause;
    });
  }

  /** Renders inline content with sentence and word spans, and returns spoken sentences. */
  private inline(inline: Inline, withSentences: boolean): { html: string; groups: { highlight: string[]; words: SpokenWord[] }[] } {
    const ids = inline.units.map(() => this.id('w'));
    const ranges = withSentences ? sentences(inline) : [{ start: 0, end: inline.display.length, units: inline.units.map((_, u) => u) }];
    let html = '';
    const groups: { highlight: string[]; words: SpokenWord[] }[] = [];
    for (const range of ranges) {
      const sentenceId = this.id('s');
      let body = '';
      let position = range.start;
      for (const u of range.units) {
        const unit = inline.units[u]!;
        body += pieces(inline, position, unit.start) + `<span class="w" id="${ids[u]}">${pieces(inline, unit.start, unit.end)}</span>`;
        position = unit.end;
      }
      body += pieces(inline, position, range.end);
      html += withSentences ? `<span class="s" id="${sentenceId}">${body}</span>` : body;
      // Units with nothing to say (for example emoji) stay visible; their gap folds into the previous separator.
      const spoken = range.units.filter(u => inline.units[u]!.spoken);
      const words = spoken.flatMap((u, k): SpokenWord[] => {
        const next = spoken[k + 1];
        const unit = inline.units[u]!;
        const gap = inline.display.slice(unit.end, next === undefined ? range.end : inline.units[next]!.start);
        const sep = normalizeSeparator(gap, next === undefined);
        const parts = unit.parts ?? [unit.spoken];
        return parts.map((part, n) => ({ text: part, target: ids[u]!, sep: n === parts.length - 1 ? sep : ' ' }));
      });
      if (words.length) groups.push({ highlight: [sentenceId], words });
    }
    if (!ranges.length) html = pieces(inline, 0, inline.display.length);
    return { html, groups };
  }

  textBlock(kind: BlockKind, inlineToken: Token, tag: string, extraClass: string, map: Token['map'], prefix: SpokenWord[], pause: number, level?: number): void {
    const inline = tokenize(collectRuns(inlineToken.children ?? []));
    const id = this.id('b');
    const lines = this.line(map, 0);
    const heading = level ? { level, text: inline.display.replace(/\s+/g, ' ').trim() } : undefined;
    const block = this.addBlock(kind, id, lines, heading);
    const { html, groups } = this.inline(inline, true);
    this.html.push(`<${tag} class="blk${extraClass}" id="${id}">${html}</${tag}>`);
    if (prefix.length && groups.length) groups[0]!.words.unshift(...prefix);
    else if (prefix.length) groups.push({ highlight: [id], words: [...prefix.slice(0, -1), { ...prefix.at(-1)!, sep: '.' }] });
    this.addUtterances(block, groups, pause, lines);
  }

  table(tokens: Token[], start: number): number {
    interface Cell { header: boolean; align: string; inline: Inline; id: string; html: string; words: SpokenWord[] }
    const rows: { id: string; map: Token['map']; cells: Cell[] }[] = [];
    let i = start + 1;
    for (; i < tokens.length && tokens[i]!.type !== 'table_close'; i++) {
      const token = tokens[i]!;
      if (token.type === 'tr_open') rows.push({ id: this.id('r'), map: token.map, cells: [] });
      if (token.type === 'th_open' || token.type === 'td_open') {
        const inline = tokenize(collectRuns(tokens[i + 1]?.children ?? []));
        const id = this.id('c');
        const rendered = this.inline(inline, false);
        const align = /text-align:(left|center|right)/.exec(token.attrGet('style') ?? '')?.[1] ?? '';
        rows.at(-1)?.cells.push({ header: token.type === 'th_open', align, inline, id, html: rendered.html, words: rendered.groups[0]?.words ?? [] });
      }
    }
    const table = tokens[start]!;
    const id = this.id('b');
    const lines = this.line(table.map, 0);
    const block = this.addBlock('table', id, lines);
    const header = rows[0]?.cells.every(cell => cell.header) ? rows.shift()! : undefined;
    const row = (r: { id: string; cells: Cell[] }, tag: string) => `<tr id="${r.id}">${r.cells.map(cell =>
      `<${tag} id="${cell.id}"${cell.align ? ` class="al-${cell.align}"` : ''}>${cell.html}</${tag}>`).join('')}</tr>`;
    this.html.push(`<div class="table-wrap"><table class="blk" id="${id}">${header ? `<thead>${row(header, 'th')}</thead>` : ''}<tbody>${rows.map(r => row(r, 'td')).join('')}</tbody></table></div>`);

    const columns = Math.max(header?.cells.length ?? 0, ...rows.map(r => r.cells.length));
    const label = (c: number) => header?.cells[c]?.inline.display.replace(/\s+/g, ' ').trim() || `Column ${c + 1}`;
    const cue = (text: string, target: string | null, sep: string): SpokenWord[] => {
      const parts = text.split(/\s+/).filter(Boolean);
      return parts.map((part, k) => {
        const word = /^(.*?)([.,;:!?]*)$/.exec(part)!;
        const own = word[2] ?? '';
        const last = k === parts.length - 1;
        // A cue's own punctuation ("rows.") wins unless the caller supplies punctuation of its own.
        const finalSep = own && !/[.,;:!?]/.test(sep) ? `${own}${sep.endsWith(' ') ? ' ' : ''}` : sep;
        return { text: spokenForm(word[1] || part), target, sep: last ? finalSep : own ? `${own} ` : ' ' };
      });
    };
    const value = (cell: Cell | undefined, sep: string, fallbackTarget: string | null): SpokenWord[] => {
      const words = cell?.words.filter(word => word.text).map(word => ({ ...word })) ?? [];
      if (!words.length) return cue('empty', cell?.id ?? fallbackTarget, sep);
      words.at(-1)!.sep = sep;
      return words;
    };
    const intro: SpokenWord[] = cue(`Table with ${rows.length} ${rows.length === 1 ? 'row' : 'rows'}.`, null, ' ');
    if (columns) {
      intro.push(...cue('Columns:', null, ' '));
      for (let c = 0; c < columns; c++) intro.push(...cue(label(c), header?.cells[c]?.id ?? null, c === columns - 1 ? '.' : ', '));
    }
    intro.at(-1)!.sep = '.';
    const groups: { highlight: string[]; words: SpokenWord[]; lines: [number, number] }[] = [
      { highlight: [header?.id ?? id], words: intro, lines: this.line(header?.map ?? table.map, 0) }
    ];
    if (this.options.tableMode === 'columns') {
      for (let c = 0; c < columns; c++) {
        const words = cue(`Column ${label(c)}`, header?.cells[c]?.id ?? null, '. ');
        rows.forEach((r, index) => {
          if (c === 0) words.push(...cue(`Row ${index + 1}:`, r.cells[0]?.id ?? r.id, ' '));
          else words.push(...value(r.cells[0], ': ', r.id));
          words.push(...value(r.cells[c], '. ', r.id));
        });
        words.at(-1)!.sep = '.';
        groups.push({ highlight: [header?.cells[c]?.id, ...rows.map(r => r.cells[c]?.id)].filter((x): x is string => !!x), words, lines: lines });
      }
    } else {
      for (const r of rows) {
        const words = value(r.cells[0], '. ', r.id);
        for (let c = 1; c < columns; c++) {
          words.push(...cue(label(c), header?.cells[c]?.id ?? null, ': '));
          words.push(...value(r.cells[c], '. ', r.id));
        }
        words.at(-1)!.sep = '.';
        groups.push({ highlight: [r.id], words, lines: this.line(r.map, lines[0]) });
      }
    }
    groups.forEach((group, index) => {
      const chunks = splitWords(group.words);
      chunks.forEach((chunk, k) => {
        if (this.blocks[block]!.first < 0) this.blocks[block]!.first = this.utterances.length;
        this.utterances.push({
          block, highlight: group.highlight, words: chunk, line: group.lines[0], endLine: group.lines[1],
          pauseAfter: k < chunks.length - 1 ? PAUSE.clause : PAUSE.row
        });
      });
      if (index === groups.length - 1) this.utterances.at(-1)!.pauseAfter = PAUSE.paragraph;
    });
    return i;
  }

  code(token: Token): void {
    const id = this.id('b');
    const lines = this.line(token.map, 0);
    const block = this.addBlock('code', id, lines);
    const source = token.content.replace(/\n$/, '');
    const language = token.info.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
    const count = source ? source.split('\n').length : 0;
    if (this.options.codeBlocks === 'read') {
      const lineIds = source.split('\n').map(() => this.id('l'));
      this.html.push(`<pre class="blk code-block" id="${id}"><code>${source.split('\n').map((text, k) =>
        `<span class="line" id="${lineIds[k]}">${escapeHtml(text)}</span>`).join('\n')}</code></pre>`);
      const groups = source.split('\n').flatMap((text, k) => {
        const words = text.trim().split(/\s+/).filter(Boolean).map((part, n, all) => ({ text: part, target: lineIds[k]!, sep: n === all.length - 1 ? '.' : ' ' }));
        return words.length ? [{ highlight: [lineIds[k]!], words }] : [];
      });
      this.addUtterances(block, groups, PAUSE.code, lines);
      return;
    }
    this.html.push(`<pre class="blk code-block" id="${id}"><code>${escapeHtml(source)}</code></pre>`);
    if (this.options.codeBlocks === 'skip') return;
    const kind = language === 'mermaid' ? 'Diagram' : 'Code block';
    const name = language === 'mermaid' ? '' : LANGUAGES[language] ?? (language ? language : '');
    const words = `${kind}${name ? `, ${name}` : ''}, ${count} ${count === 1 ? 'line' : 'lines'}`.split(' ')
      .map((part, k, all) => ({ text: part.replace(/,$/, ''), target: null, sep: k === all.length - 1 ? '.' : part.endsWith(',') ? ', ' : ' ' }));
    this.addUtterances(block, [{ highlight: [id], words }], PAUSE.code, lines);
  }

  htmlBlock(token: Token): void {
    if (/^\s*<!--/.test(token.content)) return;
    const id = this.id('b');
    this.addBlock('html', id, this.line(token.map, 0));
    this.html.push(`<div class="blk html-note" id="${id}" title="Raw HTML is not rendered or read.">HTML content not shown</div>`);
  }

  rule(): void {
    this.html.push('<hr>');
    const last = this.utterances.at(-1);
    if (last) last.pauseAfter = Math.max(last.pauseAfter, PAUSE.rule);
  }

  raw(html: string): void { this.html.push(html); }
  nextId(prefix: string): string { return this.id(prefix); }
}

function splitWords(words: SpokenWord[]): SpokenWord[][] {
  const chunks: SpokenWord[][] = [];
  let current: SpokenWord[] = [];
  let length = 0;
  for (const word of words) {
    // Very long single units (for example long inline code) are divided so no request exceeds the limit.
    const parts = word.text.length > HARD_LIMIT ? word.text.match(new RegExp(`.{1,${HARD_LIMIT}}`, 'g'))! : [word.text];
    parts.forEach((part, k) => {
      const piece = { ...word, text: part, sep: k === parts.length - 1 ? word.sep : ' ' };
      if (current.length && length + part.length > HARD_LIMIT) {
        chunks.push(current);
        current = [];
        length = 0;
      }
      current.push(piece);
      length += part.length + piece.sep.length;
      if (length >= SOFT_LIMIT && /[,;:—)]\s*$/.test(piece.sep)) {
        chunks.push(current);
        current = [];
        length = 0;
      }
    });
  }
  if (current.length) {
    const previous = chunks.at(-1);
    const size = (list: SpokenWord[]) => list.reduce((sum, word) => sum + word.text.length + word.sep.length, 0);
    if (previous && size(current) < 40 && size(previous) + size(current) <= HARD_LIMIT) previous.push(...current);
    else chunks.push(current);
  }
  return chunks;
}

/** Splits free text into spoken words whose punctuation becomes separators. */
export function textWords(text: string, target: string | null): SpokenWord[] {
  const parts = text.replace(/[*_`#>|]/g, ' ').split(/\s+/).filter(Boolean);
  const words: SpokenWord[] = [];
  for (const part of parts) {
    const match = /^["'“‘(]*(.*?)([.,;:!?"'”’)]*)$/.exec(part)!;
    const word = spokenForm(match[1] ?? '');
    if (!word || (!/[\p{L}\p{N}]/u.test(word) && !SPEAKABLE_SYMBOLS.test(word))) {
      if (words.length) words.at(-1)!.sep = normalizeSeparator(words.at(-1)!.sep + part, false);
      continue;
    }
    words.push({ text: word, target, sep: normalizeSeparator(match[2] ?? '', false) });
  }
  if (words.length) words.at(-1)!.sep = normalizeSeparator(words.at(-1)!.sep, true);
  return words;
}

function applyOverrides(document: ReaderDocument, overrides: ReadonlyMap<number, string>): void {
  for (const [block, text] of [...overrides].sort((a, b) => a[0] - b[0])) {
    const info = document.blocks[block];
    if (!info) continue;
    const words = textWords(text, info.id);
    if (!words.length) continue;
    const sentences: SpokenWord[][] = [[]];
    for (const word of words) {
      sentences.at(-1)!.push(word);
      if (/[.!?]/.test(word.sep)) sentences.push([]);
    }
    const replacement = sentences.filter(list => list.length).flatMap(list => splitWords(list)).map((chunk, k, all): Utterance => ({
      block, highlight: [info.id], words: chunk, pauseAfter: k === all.length - 1 ? PAUSE.paragraph : PAUSE.sentence,
      line: info.line, endLine: info.endLine
    }));
    let at = document.utterances.findIndex(u => u.block >= block);
    if (at < 0) at = document.utterances.length;
    const removed = document.utterances.filter(u => u.block === block).length;
    document.utterances.splice(at, removed, ...replacement);
  }
  document.blocks.forEach((info, index) => { info.first = document.utterances.findIndex(u => u.block === index); });
}

/** Builds the rendered reader HTML and the spoken utterances for a Markdown document. */
export function buildDocument(markdown: string, options: Partial<DocumentOptions> = {}): ReaderDocument {
  const settings = { ...defaults, ...options };
  const tokens = parser.parse(stripFrontMatter(markdown), {});
  const builder = new Builder(settings);
  const lists: { ordered: boolean; next: number }[] = [];
  const items: { prefix: SpokenWord[]; first: boolean }[] = [];
  const quotes: { alert?: string; titleId?: string; first: boolean }[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    switch (token.type) {
      case 'heading_open': {
        builder.textBlock('heading', tokens[i + 1]!, token.tag, '', token.map, [], PAUSE.heading, Number(token.tag.slice(1)));
        i += 2;
        break;
      }
      case 'paragraph_open': {
        const inline = tokens[i + 1]!;
        const item = items.at(-1);
        const quote = quotes.at(-1);
        const prefix: SpokenWord[] = [];
        let kind: BlockKind = 'paragraph';
        let pause = PAUSE.paragraph;
        if (quote?.first) {
          quote.first = false;
          prefix.push(quote.alert ? { text: `${quote.alert}:`, target: quote.titleId ?? null, sep: ' ' } : { text: 'Quote:', target: null, sep: ' ' });
        }
        if (item && token.map && items.length && lists.length) {
          kind = 'item';
          pause = PAUSE.item;
          if (item.first) {
            prefix.push(...item.prefix);
            item.first = false;
          }
        }
        builder.textBlock(kind, inline, token.hidden ? 'div' : 'p', token.hidden ? ' tight' : '', token.map, prefix, pause);
        i += 2;
        break;
      }
      case 'bullet_list_open':
        lists.push({ ordered: false, next: 1 });
        builder.raw('<ul>');
        break;
      case 'ordered_list_open': {
        const start = Number(token.attrGet('start') ?? 1);
        lists.push({ ordered: true, next: start });
        builder.raw(start === 1 ? '<ol>' : `<ol start="${start}">`);
        break;
      }
      case 'bullet_list_close': lists.pop(); builder.raw('</ul>'); break;
      case 'ordered_list_close': lists.pop(); builder.raw('</ol>'); break;
      case 'list_item_open': {
        const list = lists.at(-1);
        const prefix: SpokenWord[] = [];
        if (list?.ordered) prefix.push({ text: `${list.next++}.`, target: null, sep: ' ' });
        const inline = tokens[i + 1]?.type === 'paragraph_open' ? tokens[i + 2] : undefined;
        const first = inline?.children?.[0];
        const task = first?.type === 'text' ? /^\[([ xX])\]\s+/.exec(first.content) : null;
        if (task && first) {
          first.content = first.content.slice(task[0].length);
          const done = task[1] !== ' ';
          const checkId = builder.nextId('k');
          builder.raw(`<li class="task${done ? ' done' : ''}"><span class="check" id="${checkId}" aria-hidden="true">${done ? '☑' : '☐'}</span>`);
          prefix.push({ text: done ? 'Completed:' : 'Not completed:', target: checkId, sep: ' ' });
        } else {
          builder.raw('<li>');
        }
        items.push({ prefix, first: true });
        break;
      }
      case 'list_item_close': items.pop(); builder.raw('</li>'); break;
      case 'blockquote_open': {
        const inline = tokens[i + 1]?.type === 'paragraph_open' ? tokens[i + 2] : undefined;
        const first = inline?.children?.[0];
        const alert = first?.type === 'text' ? /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*$/i.exec(first.content) : null;
        if (alert && inline?.children) {
          const name = ALERTS[alert[1]!.toUpperCase()]!;
          const titleId = builder.nextId('t');
          inline.children.splice(0, inline.children[1]?.type === 'softbreak' ? 2 : 1);
          builder.raw(`<div class="callout callout-${name.toLowerCase()}"><div class="callout-title" id="${titleId}">${name}</div>`);
          quotes.push({ alert: name, titleId, first: true });
        } else {
          builder.raw('<blockquote>');
          quotes.push({ first: true });
        }
        break;
      }
      case 'blockquote_close':
        builder.raw(quotes.pop()?.alert ? '</div>' : '</blockquote>');
        break;
      case 'table_open': i = builder.table(tokens, i); break;
      case 'fence': case 'code_block': builder.code(token); break;
      case 'html_block': builder.htmlBlock(token); break;
      case 'hr': builder.rule(); break;
    }
  }
  const document = builder.result();
  if (settings.overrides?.size) applyOverrides(document, settings.overrides);
  return document;
}
