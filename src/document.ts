import MarkdownIt from 'markdown-it';
import type Token from 'markdown-it/lib/token.mjs';
import { KEY_NAMES, own } from './engine/pronounce';

export type BlockKind = 'heading' | 'paragraph' | 'item' | 'table' | 'code' | 'html';

/** A span of the Markdown source, in document coordinates (zero-based, end exclusive). */
export interface SourceRange { line: number; character: number; endLine: number; endCharacter: number }

export interface SpokenWord {
  /** Text to speak for this unit, before pronunciation rules. */
  text: string;
  /** Whitespace and punctuation spoken after the unit; shapes pauses and intonation. */
  sep: string;
  /** Source text highlighted while the unit is spoken; null for spoken-only cues. */
  range: SourceRange | null;
}

export interface Utterance {
  block: number;
  /**
   * Which stop within its block this belongs to when moving by paragraph: a table's introduction and
   * each of its rows (or columns, when reading by column) are separate stops; other blocks are one stop.
   */
  part: number;
  words: SpokenWord[];
  /** Source highlighted for the whole utterance: the sentence, a table row or a code block. */
  range: SourceRange | null;
  /** Total silence after this utterance, in seconds at 1x. */
  pauseAfter: number;
  line: number;
  endLine: number;
}

export interface ReaderBlock {
  kind: BlockKind;
  line: number;
  endLine: number;
  /** First utterance index, or -1 for blocks that are not spoken. */
  first: number;
  heading?: { level: number; text: string };
}

export interface ReaderDocument {
  utterances: Utterance[];
  blocks: ReaderBlock[];
}

export interface DocumentOptions {
  tableMode: 'rows' | 'columns';
  codeBlocks: 'announce' | 'read' | 'skip';
  /** Where the text starts in the document, for reading a selection. */
  lineOffset: number;
  characterOffset: number;
  /** Approved replacement narration (for example from Copilot), keyed by block index. */
  overrides?: ReadonlyMap<number, string>;
}

const defaults: DocumentOptions = { tableMode: 'rows', codeBlocks: 'announce', lineOffset: 0, characterOffset: 0 };
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

function normalizeSeparator(text: string, final: boolean): string {
  const marks = (text.replace(/(^|\s)[–-]+(?=\s|$)/g, '$1—').match(SPOKEN_SEPARATOR) ?? []).join('');
  if (final) return /[.!?]/.test(marks) ? marks : `${marks.replace(/[,;:—]+$/, '')}.`;
  // A line break that does not end a sentence (for example in a table cell) is a short pause.
  if (!marks && text.includes('\n')) return ', ';
  return marks ? `${marks} ` : ' ';
}

function spokenForm(text: string): string {
  let value = text.replace(/\p{Extended_Pictographic}|\uFE0F|\u200D/gu, '').replace(/\s+/g, ' ').trim();
  if (/^(?:https?:\/\/|www\.)\S+$/i.test(value)) {
    try { value = new URL(value.startsWith('www.') ? `https://${value}` : value).hostname.replace(/^www\./, ''); } catch { /* keep text */ }
  }
  return value;
}

export function stripFrontMatter(markdown: string): string {
  // Replace YAML front matter with blank lines so source line numbers stay correct.
  return markdown.replace(/^---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)(?:\r?\n|$)/, match =>
    '\n'.repeat((match.match(/\n/g) ?? []).length));
}

/** Converts positions in the parsed text to document positions. */
export class Source {
  readonly lines: string[];

  constructor(text: string, private readonly lineOffset: number, private readonly characterOffset: number) {
    this.lines = text.split(/\r?\n/);
  }

  position(line: number, character: number): { line: number; character: number } {
    return { line: line + this.lineOffset, character: character + (line === 0 ? this.characterOffset : 0) };
  }

  range(start: { line: number; character: number }, end: { line: number; character: number }): SourceRange {
    const a = this.position(start.line, start.character);
    const b = this.position(end.line, end.character);
    return { line: a.line, character: a.character, endLine: b.line, endCharacter: b.character };
  }

  /** The whole of parsed lines [start, end). */
  lineRange(start: number, end: number): SourceRange {
    const last = Math.max(start, Math.min(end, this.lines.length) - 1);
    return this.range({ line: start, character: 0 }, { line: last, character: this.lines[last]?.length ?? 0 });
  }

  /** Extends a range over the closing punctuation, emphasis markers and link target that follow it. */
  extend(range: SourceRange | null): SourceRange | null {
    if (!range) return null;
    const local = range.endLine - this.lineOffset;
    const shift = local === 0 ? this.characterOffset : 0;
    const text = this.lines[local] ?? '';
    let end = range.endCharacter - shift;
    while (end < text.length) {
      if (text.startsWith('](', end)) {
        const close = text.indexOf(')', end);
        if (close < 0) break;
        end = close + 1;
      } else if (/[.,;:!?)\]"'”’*_~`]/.test(text[end]!)) end++;
      else break;
    }
    return { ...range, endCharacter: end + shift };
  }
}

/** Maps offsets in a token's inline content back to source positions. */
export interface Locator { at(offset: number): { line: number; character: number } | null }

export function locateParagraph(content: string, firstLine: number, source: Source): Locator {
  const starts: number[] = [];
  let offset = 0;
  const bases = content.split('\n').map((text, k) => {
    starts.push(offset);
    offset += text.length + 1;
    const probe = text.trim();
    const sourceLine = source.lines[firstLine + k] ?? '';
    const found = probe ? sourceLine.indexOf(probe) : -1;
    return { line: firstLine + k, column: found < 0 ? -1 : found - (text.length - text.trimStart().length) };
  });
  return {
    at(position: number) {
      let k = starts.length - 1;
      while (k > 0 && starts[k]! > position) k--;
      const base = bases[k]!;
      return base.column < 0 ? null : { line: base.line, character: base.column + position - starts[k]! };
    }
  };
}

export function locateCell(line: number, column: number): Locator {
  return { at: position => (column < 0 ? null : { line, character: column + position }) };
}

/**
 * Where a table cell's content starts in its row's source line, searching from `cursor`. markdown-it
 * unescapes "\|" in cells, so the escaped form is tried when the plain one is missing.
 */
export function cellColumn(lineText: string, content: string, cursor: number): { column: number; raw: string } {
  let raw = content;
  let column = content ? lineText.indexOf(content, cursor) : -1;
  if (column < 0 && content.includes('|')) {
    raw = content.replace(/\|/g, '\\|');
    column = lineText.indexOf(raw, cursor);
  }
  return { column, raw };
}

/**
 * Finds rendered text in a token's source content, skipping link destinations and HTML tags, and
 * tolerating markup inside a word (for example **Data**Harbor).
 */
export function textFinder(content: string): (text: string, from: number) => [number, number] | null {
  const skips = [...content.matchAll(/\]\([^)]*\)|<\/?[a-zA-Z][a-zA-Z0-9-]*(?:\s[^>]*)?\/?>/g)].map(m => [m.index!, m.index! + m[0].length] as const);
  const inSkip = (at: number) => skips.find(([a, b]) => at >= a && at < b);
  return (text, from) => {
    let at = from;
    for (;;) {
      const index = content.indexOf(text, at);
      if (index < 0) break;
      const skip = inSkip(index);
      if (!skip) return [index, index + text.length];
      at = skip[1];
    }
    const pattern = new RegExp([...text].map(ch => ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[*_~`\\\\]*'), 'g');
    pattern.lastIndex = from;
    for (let match = pattern.exec(content); match; match = pattern.exec(content)) {
      if (!inSkip(match.index)) return [match.index, match.index + match[0].length];
    }
    return null;
  };
}

interface Run { text: string; spoken?: string; atomic?: boolean; parts?: boolean }
/** A spoken unit; `parts` lists the words when one unit (inline code) holds several. */
interface Unit { start: number; end: number; spoken: string; parts?: string[] }
interface Inline { display: string; owner: number[]; runs: Run[]; units: Unit[] }

function collectRuns(children: Token[]): Run[] {
  const runs: Run[] = [];
  let autolink = false;
  let key = false;
  for (const child of children) {
    switch (child.type) {
      case 'text':
        if (!child.content) break;
        if (autolink) runs.push({ text: child.content, spoken: spokenForm(child.content), atomic: true });
        // Inside <kbd>, an arrow is a key: "right arrow", not "to".
        else if (key && own(KEY_NAMES, child.content.trim())) runs.push({ text: child.content, spoken: own(KEY_NAMES, child.content.trim()), atomic: true });
        else runs.push({ text: child.content });
        break;
      // Inline code is one highlighted unit even when it contains several words.
      case 'code_inline': runs.push({ text: child.content, atomic: true, parts: true }); break;
      case 'softbreak': runs.push({ text: ' ' }); break;
      // A hard line break (two trailing spaces, a backslash or <br>) ends a phrase, so it gets a pause.
      case 'hardbreak': runs.push({ text: '\n' }); break;
      case 'html_inline':
        if (/^<br\s*\/?>$/i.test(child.content)) runs.push({ text: '\n' });
        else if (/^<kbd[\s>]/i.test(child.content)) key = true;
        else if (/^<\/kbd\s*>$/i.test(child.content)) key = false;
        break;
      case 'image': {
        const alt = child.content.replace(/\s+/g, ' ').trim();
        runs.push({ text: alt || 'image', spoken: alt ? `Image: ${alt}` : 'Image', atomic: true });
        break;
      }
      case 'link_open': autolink = child.markup === 'autolink'; break;
      case 'link_close': autolink = false; break;
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
    // An asterisk between numbers is multiplication ("2 * 3" is "2 times 3"); elsewhere it is markup.
    if (token === '*' && /\d\s*$/.test(display.slice(0, start)) && /^\s*\d/.test(display.slice(i))) {
      units.push({ start, end: i, spoken: '*' });
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

interface Span { start: number; end: number; units: number[] }

function sentences(inline: Inline): Span[] {
  const spans: Span[] = [];
  let u = 0;
  for (const segment of sentenceSegmenter.segment(inline.display)) {
    const end = segment.index + segment.segment.length;
    const members: number[] = [];
    while (u < inline.units.length && inline.units[u]!.start < end) members.push(u++);
    const previous = spans.at(-1);
    if (previous && segment.index < previous.end) {
      // The segmenter broke inside a unit (for example at "?" in a URL): keep one sentence.
      previous.units.push(...members);
      previous.end = Math.max(previous.end, end, ...members.map(m => inline.units[m]!.end));
    } else if (members.length) {
      spans.push({ start: segment.index, end: Math.max(end, inline.units[members.at(-1)!]!.end), units: members });
    } else if (previous) {
      previous.end = Math.max(previous.end, end);
    }
  }
  return spans;
}

/** Finds each unit's text in the token's source content, in order. */
function sourceOffsets(content: string, inline: Inline): ([number, number] | null)[] {
  const find = textFinder(content);
  let cursor = 0;
  return inline.units.map(unit => {
    const found = find(inline.display.slice(unit.start, unit.end), cursor);
    if (found) cursor = found[1];
    return found;
  });
}

interface Group { range: SourceRange | null; words: SpokenWord[] }

function spanOf(words: SpokenWord[]): SourceRange | null {
  const ranged = words.filter(word => word.range).map(word => word.range!);
  if (!ranged.length) return null;
  const first = ranged[0]!;
  const last = ranged.at(-1)!;
  return { line: first.line, character: first.character, endLine: last.endLine, endCharacter: last.endCharacter };
}

class Builder {
  private readonly utterances: Utterance[] = [];
  private readonly blocks: ReaderBlock[] = [];

  constructor(private readonly options: DocumentOptions, private readonly source: Source) {}

  private lines(map: [number, number] | null | undefined): [number, number] {
    const [start, end] = map ?? [0, 1];
    return [start + this.options.lineOffset, Math.max(start + 1, end) + this.options.lineOffset];
  }

  result(): ReaderDocument {
    return { utterances: this.utterances, blocks: this.blocks };
  }

  private addBlock(kind: BlockKind, map: [number, number] | null | undefined, heading?: ReaderBlock['heading']): number {
    const [line, endLine] = this.lines(map);
    this.blocks.push({ kind, line, endLine, first: -1, heading });
    return this.blocks.length - 1;
  }

  /** Adds a block's spoken groups. With `separateParts`, each group (a table row) is its own paragraph stop. */
  private add(block: number, groups: Group[], pause: number, finalPause: number, separateParts = false): void {
    const spoken = groups.filter(group => group.words.some(word => word.text));
    const info = this.blocks[block]!;
    spoken.forEach((group, index) => {
      const part = separateParts ? index : 0;
      const chunks = splitWords(group.words);
      chunks.forEach((chunk, k) => {
        if (info.first < 0) info.first = this.utterances.length;
        const range = chunks.length > 1 ? this.source.extend(spanOf(chunk)) ?? group.range : group.range;
        // Lines of the text itself (a sentence or a table row), so saved positions are precise.
        const line = range ? range.line : info.line;
        const endLine = range ? range.endLine + 1 : info.endLine;
        this.utterances.push({ block, part, words: chunk, range, line, endLine, pauseAfter: k < chunks.length - 1 ? PAUSE.clause : pause });
      });
      if (index === spoken.length - 1 && this.utterances.length) this.utterances.at(-1)!.pauseAfter = finalPause;
    });
  }

  /** Spoken words for inline content, grouped into sentences, with their source ranges. */
  private groups(inline: Inline, content: string, locator: Locator, withSentences: boolean): Group[] {
    const offsets = sourceOffsets(content, inline);
    const rangeOf = (u: number): SourceRange | null => {
      const found = offsets[u];
      const start = found && locator.at(found[0]);
      const end = found && locator.at(found[1]);
      return start && end ? this.source.range(start, end) : null;
    };
    const spans = withSentences ? sentences(inline) : [{ start: 0, end: inline.display.length, units: inline.units.map((_, u) => u) }];
    const groups: Group[] = [];
    for (const span of spans) {
      // Units with nothing to say (for example emoji) fold their gap into the previous separator.
      const spoken = span.units.filter(u => inline.units[u]!.spoken);
      const words = spoken.flatMap((u, k): SpokenWord[] => {
        const next = spoken[k + 1];
        const unit = inline.units[u]!;
        const gap = inline.display.slice(unit.end, next === undefined ? span.end : inline.units[next]!.start);
        const sep = normalizeSeparator(gap, next === undefined);
        const parts = unit.parts ?? [unit.spoken];
        const range = rangeOf(u);
        return parts.map((part, n) => ({ text: part, sep: n === parts.length - 1 ? sep : ' ', range }));
      });
      if (words.length) groups.push({ range: this.source.extend(spanOf(words)), words });
    }
    return groups;
  }

  textBlock(kind: BlockKind, token: Token, inlineToken: Token, prefix: SpokenWord[], pause: number, level?: number): void {
    const inline = tokenize(collectRuns(inlineToken.children ?? []));
    const heading = level ? { level, text: inline.display.replace(/\s+/g, ' ').trim() } : undefined;
    const block = this.addBlock(kind, token.map, heading);
    const locator = locateParagraph(inlineToken.content, token.map?.[0] ?? 0, this.source);
    const groups = this.groups(inline, inlineToken.content, locator, true);
    if (prefix.length && groups.length) groups[0]!.words.unshift(...prefix);
    else if (prefix.length) groups.push({ range: null, words: [...prefix.slice(0, -1), { ...prefix.at(-1)!, sep: '.' }] });
    this.add(block, groups, PAUSE.sentence, pause);
  }

  table(tokens: Token[], start: number): number {
    interface Cell { header: boolean; inline: Inline; range: SourceRange | null; words: SpokenWord[] }
    const rows: { map: Token['map']; cells: Cell[] }[] = [];
    let cursor = 0;
    let i = start + 1;
    for (; i < tokens.length && tokens[i]!.type !== 'table_close'; i++) {
      const token = tokens[i]!;
      if (token.type === 'tr_open') {
        rows.push({ map: token.map, cells: [] });
        cursor = 0;
      }
      if (token.type === 'th_open' || token.type === 'td_open') {
        const inlineToken = tokens[i + 1]!;
        const content = inlineToken.content;
        const line = rows.at(-1)?.map?.[0] ?? 0;
        const lineText = this.source.lines[line] ?? '';
        const { column, raw } = cellColumn(lineText, content, cursor);
        if (column >= 0) cursor = column + raw.length;
        const inline = tokenize(collectRuns(inlineToken.children ?? []));
        const words = this.groups(inline, raw, locateCell(line, column), false)[0]?.words ?? [];
        const range = column >= 0 && raw ? this.source.range({ line, character: column }, { line, character: column + raw.length }) : null;
        rows.at(-1)?.cells.push({ header: token.type === 'th_open', inline, range, words });
      }
    }
    const tableToken = tokens[start]!;
    const block = this.addBlock('table', tableToken.map);
    const header = rows[0]?.cells.every(cell => cell.header) ? rows.shift()! : undefined;
    const columns = Math.max(header?.cells.length ?? 0, ...rows.map(r => r.cells.length));
    const label = (c: number) => header?.cells[c]?.inline.display.replace(/\s+/g, ' ').trim() || `Column ${c + 1}`;
    const cue = (text: string, range: SourceRange | null, sep: string): SpokenWord[] => {
      const parts = text.split(/\s+/).filter(Boolean);
      return parts.map((part, k) => {
        const word = /^(.*?)([.,;:!?]*)$/.exec(part)!;
        const own = word[2] ?? '';
        // A cue's own punctuation ("rows.") wins unless the caller supplies punctuation of its own.
        const finalSep = own && !/[.,;:!?]/.test(sep) ? `${own}${sep.endsWith(' ') ? ' ' : ''}` : sep;
        return { text: spokenForm(word[1] || part), range, sep: k === parts.length - 1 ? finalSep : own ? `${own} ` : ' ' };
      });
    };
    const value = (cell: Cell | undefined, sep: string): SpokenWord[] => {
      const words = cell?.words.filter(word => word.text).map(word => ({ ...word })) ?? [];
      if (!words.length) return cue('empty', cell?.range ?? null, sep);
      words.at(-1)!.sep = sep;
      return words;
    };
    const rowRange = (map: Token['map']) => (map ? this.source.lineRange(map[0], map[0] + 1) : null);
    const intro: SpokenWord[] = cue(`Table with ${rows.length} ${rows.length === 1 ? 'row' : 'rows'}.`, null, ' ');
    if (columns) {
      intro.push(...cue('Columns:', null, ' '));
      for (let c = 0; c < columns; c++) intro.push(...cue(label(c), header?.cells[c]?.range ?? null, c === columns - 1 ? '.' : ', '));
    }
    intro.at(-1)!.sep = '.';
    const groups: Group[] = [{ range: rowRange(header?.map ?? tableToken.map), words: intro }];
    if (this.options.tableMode === 'columns') {
      for (let c = 0; c < columns; c++) {
        const words = cue(`Column ${label(c)}`, header?.cells[c]?.range ?? null, '. ');
        rows.forEach((r, index) => {
          if (c === 0) words.push(...cue(`Row ${index + 1}:`, null, ' '));
          else words.push(...value(r.cells[0], ': '));
          words.push(...value(r.cells[c], '. '));
        });
        words.at(-1)!.sep = '.';
        groups.push({ range: spanOf(words), words });
      }
    } else {
      for (const r of rows) {
        const words = value(r.cells[0], '. ');
        for (let c = 1; c < columns; c++) {
          words.push(...cue(label(c), header?.cells[c]?.range ?? null, ': '));
          words.push(...value(r.cells[c], '. '));
        }
        words.at(-1)!.sep = '.';
        groups.push({ range: rowRange(r.map), words });
      }
    }
    this.add(block, groups, PAUSE.row, PAUSE.paragraph, true);
    return i;
  }

  code(token: Token): void {
    const block = this.addBlock('code', token.map);
    const source = token.content.replace(/\n$/, '');
    const language = token.info.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
    const count = source ? source.split('\n').length : 0;
    const [first, end] = token.map ?? [0, 1];
    if (this.options.codeBlocks === 'skip') return;
    if (this.options.codeBlocks === 'read') {
      // Fenced code starts one line after the fence; indented code starts on its first line.
      const offset = token.type === 'fence' ? 1 : 0;
      const groups = source.split('\n').flatMap((text, k): Group[] => {
        const range = this.source.lineRange(first + offset + k, first + offset + k + 1);
        const words = text.trim().split(/\s+/).filter(Boolean).map((part, n, all) => ({ text: part, range, sep: n === all.length - 1 ? '.' : ' ' }));
        return words.length ? [{ range, words }] : [];
      });
      this.add(block, groups, PAUSE.sentence, PAUSE.code);
      return;
    }
    const kind = language === 'mermaid' ? 'Diagram' : 'Code block';
    const name = language === 'mermaid' ? '' : own(LANGUAGES, language) ?? (language ? language : '');
    const words = `${kind}${name ? `, ${name}` : ''}, ${count} ${count === 1 ? 'line' : 'lines'}`.split(' ')
      .map((part, k, all) => ({ text: part.replace(/,$/, ''), range: null, sep: k === all.length - 1 ? '.' : part.endsWith(',') ? ', ' : ' ' }));
    this.add(block, [{ range: this.source.lineRange(first, end), words }], PAUSE.sentence, PAUSE.code);
  }

  htmlBlock(token: Token): void {
    if (!/^\s*<!--/.test(token.content)) this.addBlock('html', token.map);
  }

  rule(): void {
    const last = this.utterances.at(-1);
    if (last) last.pauseAfter = Math.max(last.pauseAfter, PAUSE.rule);
  }
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
export function textWords(text: string): SpokenWord[] {
  const parts = text.replace(/[*_`#>|]/g, ' ').split(/\s+/).filter(Boolean);
  const words: SpokenWord[] = [];
  for (const part of parts) {
    const match = /^["'“‘(]*(.*?)([.,;:!?"'”’)]*)$/.exec(part)!;
    const word = spokenForm(match[1] ?? '');
    if (!word || (!/[\p{L}\p{N}]/u.test(word) && !SPEAKABLE_SYMBOLS.test(word))) {
      if (words.length) words.at(-1)!.sep = normalizeSeparator(words.at(-1)!.sep + part, false);
      continue;
    }
    words.push({ text: word, range: null, sep: normalizeSeparator(match[2] ?? '', false) });
  }
  if (words.length) words.at(-1)!.sep = normalizeSeparator(words.at(-1)!.sep, true);
  return words;
}

function applyOverrides(document: ReaderDocument, overrides: ReadonlyMap<number, string>, source: Source, lineOffset: number): void {
  for (const [block, text] of [...overrides].sort((a, b) => a[0] - b[0])) {
    const info = document.blocks[block];
    if (!info) continue;
    const words = textWords(text);
    if (!words.length) continue;
    const range = source.lineRange(info.line - lineOffset, info.endLine - lineOffset);
    const sentencesOf: SpokenWord[][] = [[]];
    for (const word of words) {
      sentencesOf.at(-1)!.push(word);
      if (/[.!?]/.test(word.sep)) sentencesOf.push([]);
    }
    const replacement = sentencesOf.filter(list => list.length).flatMap(list => splitWords(list)).map((chunk, k, all): Utterance => ({
      block, part: 0, words: chunk, range, pauseAfter: k === all.length - 1 ? PAUSE.paragraph : PAUSE.sentence, line: info.line, endLine: info.endLine
    }));
    let at = document.utterances.findIndex(u => u.block >= block);
    if (at < 0) at = document.utterances.length;
    const removed = document.utterances.filter(u => u.block === block).length;
    document.utterances.splice(at, removed, ...replacement);
  }
  document.blocks.forEach((info, index) => { info.first = document.utterances.findIndex(u => u.block === index); });
}

/** Builds the spoken utterances for a Markdown document, each mapped to its source text. */
export function buildDocument(markdown: string, options: Partial<DocumentOptions> = {}): ReaderDocument {
  const settings = { ...defaults, ...options };
  const text = stripFrontMatter(markdown);
  const source = new Source(text, settings.lineOffset, settings.characterOffset);
  const tokens = parser.parse(text, {});
  const builder = new Builder(settings, source);
  const lists: { ordered: boolean; next: number }[] = [];
  const items: { prefix: SpokenWord[]; first: boolean }[] = [];
  const quotes: { alert?: string; first: boolean }[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    switch (token.type) {
      case 'heading_open':
        builder.textBlock('heading', token, tokens[i + 1]!, [], PAUSE.heading, Number(token.tag.slice(1)));
        i += 2;
        break;
      case 'paragraph_open': {
        const item = items.at(-1);
        const quote = quotes.at(-1);
        const prefix: SpokenWord[] = [];
        let kind: BlockKind = 'paragraph';
        let pause = PAUSE.paragraph;
        if (quote?.first) {
          quote.first = false;
          prefix.push({ text: quote.alert ? `${quote.alert}:` : 'Quote:', range: null, sep: ' ' });
        }
        if (item) {
          kind = 'item';
          pause = PAUSE.item;
          if (item.first) {
            prefix.push(...item.prefix);
            item.first = false;
          }
        }
        builder.textBlock(kind, token, tokens[i + 1]!, prefix, pause);
        i += 2;
        break;
      }
      case 'bullet_list_open':
        lists.push({ ordered: false, next: 1 });
        break;
      case 'ordered_list_open':
        lists.push({ ordered: true, next: Number(token.attrGet('start') ?? 1) });
        break;
      case 'bullet_list_close': case 'ordered_list_close':
        lists.pop();
        break;
      case 'list_item_open': {
        const list = lists.at(-1);
        const prefix: SpokenWord[] = [];
        if (list?.ordered) prefix.push({ text: `${list.next++}.`, range: null, sep: ' ' });
        const inline = tokens[i + 1]?.type === 'paragraph_open' ? tokens[i + 2] : undefined;
        const first = inline?.children?.[0];
        const task = first?.type === 'text' ? /^\[([ xX])\]\s+/.exec(first.content) : null;
        if (task && first) {
          first.content = first.content.slice(task[0].length);
          prefix.push({ text: task[1] !== ' ' ? 'Completed:' : 'Not completed:', range: null, sep: ' ' });
        }
        items.push({ prefix, first: true });
        break;
      }
      case 'list_item_close':
        items.pop();
        break;
      case 'blockquote_open': {
        const inline = tokens[i + 1]?.type === 'paragraph_open' ? tokens[i + 2] : undefined;
        const first = inline?.children?.[0];
        const alert = first?.type === 'text' ? /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*$/i.exec(first.content) : null;
        if (alert && inline?.children) {
          inline.children.splice(0, inline.children[1]?.type === 'softbreak' ? 2 : 1);
          quotes.push({ alert: ALERTS[alert[1]!.toUpperCase()]!, first: true });
        } else {
          quotes.push({ first: true });
        }
        break;
      }
      case 'blockquote_close':
        quotes.pop();
        break;
      case 'table_open': i = builder.table(tokens, i); break;
      case 'fence': case 'code_block': builder.code(token); break;
      case 'html_block': builder.htmlBlock(token); break;
      case 'hr': builder.rule(); break;
    }
  }
  const document = builder.result();
  if (settings.overrides?.size) applyOverrides(document, settings.overrides, source, settings.lineOffset);
  return document;
}
