import MarkdownIt from 'markdown-it';
import type Token from 'markdown-it/lib/token.mjs';

export type SegmentKind = 'heading' | 'paragraph' | 'list' | 'table' | 'code' | 'quote';
export interface Segment {
  text: string;
  kind: SegmentKind;
  line: number;
}
export interface NarrationOptions {
  tableMode: 'rows' | 'columns';
  codeBlocks: 'announce' | 'read';
}
const parser = new MarkdownIt({ html: true, linkify: false });
const defaults: NarrationOptions = { tableMode: 'rows', codeBlocks: 'announce' };

function clean(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function sentence(text: string): string {
  const value = clean(text);
  return /[.!?:;]$/.test(value) ? value : `${value}.`;
}

function inline(token: Token): string {
  return clean((token.children ?? []).map(child => {
    if (child.type === 'image') return `Image: ${child.content || 'no description'}.`;
    if (child.type === 'softbreak' || child.type === 'hardbreak') return ' ';
    if (child.type === 'text' || child.type === 'code_inline') {
      const value = child.content;
      if (/^https?:\/\/\S+$/.test(value)) {
        try { return new URL(value).hostname; } catch { return value; }
      }
      return value;
    }
    return '';
  }).join(''));
}

export function splitSpeech(text: string, limit = 650): string[] {
  if (!Number.isInteger(limit) || limit < 20) throw new Error('Speech chunk limit must be at least 20.');
  const result: string[] = [];
  let chunk = '';
  const sentences = new Intl.Segmenter('en', { granularity: 'sentence' }).segment(clean(text));
  for (const { segment } of sentences) {
    const part = segment.trim();
    if (!part) continue;
    if (chunk && chunk.length + part.length + 1 > limit) {
      result.push(chunk);
      chunk = '';
    }
    if (part.length <= limit) {
      chunk = chunk ? `${chunk} ${part}` : part;
      continue;
    }
    for (const word of part.split(' ')) {
      if (chunk && chunk.length + word.length + 1 > limit) {
        result.push(chunk);
        chunk = '';
      }
      if (word.length > limit) {
        for (let offset = 0; offset < word.length; offset += limit) {
          result.push(word.slice(offset, offset + limit));
        }
      } else {
        chunk = chunk ? `${chunk} ${word}` : word;
      }
    }
  }
  if (chunk) result.push(chunk);
  return result;
}

export function parseProposal(text: string, originals: Segment[]): Segment[] {
  let parsed: unknown;
  try { parsed = JSON.parse(text); }
  catch { throw new Error('Copilot did not return valid narration JSON. Original narration is unchanged.'); }
  if (!Array.isArray(parsed) || parsed.length !== originals.length ||
      !parsed.every((item: unknown) => typeof item === 'string' && item.trim().length > 0 && item.length <= 8000)) {
    throw new Error('Copilot changed the passage count or returned invalid passages. Original narration is unchanged.');
  }
  return parsed.flatMap((text: string, index: number) =>
    splitSpeech(text).map(part => ({ ...originals[index]!, text: part })));
}

export function narrate(markdown: string, options: Partial<NarrationOptions> = {}): Segment[] {
  const settings = { ...defaults, ...options };
  // Keep the original line numbers while omitting YAML front matter.
  const source = markdown.replace(/^---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)(?:\r?\n|$)/, match =>
    '\n'.repeat((match.match(/\n/g) ?? []).length));
  const tokens = parser.parse(source, {});
  const result: Segment[] = [];
  const lists: { ordered: boolean; next: number; first: boolean }[] = [];
  let quoteDepth = 0;
  const add = (text: string, kind: SegmentKind, line: number) => {
    for (const part of splitSpeech(text)) result.push({ text: part, kind, line });
  };

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    const line = token.map?.[0] ?? 0;
    if (token.type === 'table_open') {
      const rows: { cells: string[]; line: number }[] = [];
      let row: { cells: string[]; line: number } | undefined;
      let headers: string[] = [];
      for (i++; i < tokens.length && tokens[i]!.type !== 'table_close'; i++) {
        const cell = tokens[i]!;
        if (cell.type === 'tr_open') row = { cells: [], line: cell.map?.[0] ?? line };
        if (cell.type === 'inline') row?.cells.push(inline(cell) || 'empty');
        if (cell.type === 'tr_close' && row) rows.push(row);
        if (cell.type === 'thead_close') headers = rows.shift()?.cells ?? [];
      }
      add(`Table with ${rows.length} ${rows.length === 1 ? 'row' : 'rows'} and ${headers.length} columns.`, 'table', line);
      if (settings.tableMode === 'columns') {
        headers.forEach((header, column) => {
          const text = rows.map((item, index) =>
            sentence(`Row ${index + 1}${column > 0 ? `, ${item.cells[0]}` : ''}: ${item.cells[column] ?? 'empty'}`));
          add(`${sentence(`Column ${header}`)} ${text.join(' ')}`, 'table', line);
        });
      } else {
        rows.forEach((item, index) => {
          add(`Row ${index + 1}. ${headers.map((header, column) =>
            sentence(`${header}: ${item.cells[column] ?? 'empty'}`)).join(' ')}`, 'table', item.line);
        });
      }
      continue;
    }
    if (token.type === 'bullet_list_open' || token.type === 'ordered_list_open') {
      lists.push({ ordered: token.type === 'ordered_list_open', next: Number(token.attrGet('start') ?? 1), first: true });
    } else if (token.type === 'bullet_list_close' || token.type === 'ordered_list_close') {
      lists.pop();
    } else if (token.type === 'list_item_open') {
      if (lists.length) lists[lists.length - 1]!.first = true;
    } else if (token.type === 'blockquote_open') {
      quoteDepth++;
    } else if (token.type === 'blockquote_close') {
      quoteDepth--;
    } else if (token.type === 'inline') {
      let text = inline(token);
      if (!text) continue;
      const parent = tokens[i - 1];
      let kind: SegmentKind = parent?.type === 'heading_open' ? 'heading' : 'paragraph';
      const list = lists[lists.length - 1];
      if (list) {
        kind = 'list';
        if (list.first) {
          text = text.replace(/^\[([ xX])\]\s*/, (_, check: string) => check === ' ' ? 'Not completed. ' : 'Completed. ');
          if (list.ordered) text = `${list.next++}. ${text}`;
          if (lists.length > 1) text = `Sub-item: ${text}`;
          list.first = false;
        }
      } else if (quoteDepth) {
        text = `Quote: ${text}`;
        kind = 'quote';
      }
      add(sentence(text), kind, line);
    } else if (token.type === 'fence' || token.type === 'code_block') {
      const count = token.content.trimEnd().split('\n').length;
      const label = token.info.trim().split(/\s+/)[0];
      add(`Code block${label ? `, ${label}` : ''}, ${count} ${count === 1 ? 'line' : 'lines'}.`, 'code', line);
      if (settings.codeBlocks === 'read') add(token.content, 'code', line);
      else add('Code contents skipped. Use the code block setting to read them.', 'code', line);
    } else if (token.type === 'html_block') {
      add('HTML block omitted from narration.', 'code', line);
    }
  }
  return result;
}
