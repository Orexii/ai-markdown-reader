import type { ReaderDocument, SourceRange } from './document';

export interface Point { line: number; character: number }
/** One edit, described against the text before it was made. */
export interface TextChange { start: Point; end: Point; text: string }

const compare = (a: Point, b: Point) => a.line - b.line || a.character - b.character;

/** Moves a point at or after the end of `change` to where it is after the change. */
function shiftPoint(point: Point, change: TextChange): Point {
  const lines = change.text.split(/\r\n|\r|\n/);
  const endLine = change.start.line + lines.length - 1;
  const endCharacter = (lines.length === 1 ? change.start.character : 0) + lines.at(-1)!.length;
  if (point.line === change.end.line) return { line: endLine, character: endCharacter + point.character - change.end.character };
  return { line: point.line + endLine - change.end.line, character: point.character };
}

/**
 * Returns where a range is after an edit: unchanged before it, moved after it, stretched when the
 * edit is inside it, and null when the edit replaced part of the text it pointed at.
 */
export function shiftRange(range: SourceRange, change: TextChange): SourceRange | null {
  const start = { line: range.line, character: range.character };
  const end = { line: range.endLine, character: range.endCharacter };
  if (compare(end, change.start) <= 0 && compare(start, change.start) < 0) return range;
  if (compare(start, change.end) >= 0) {
    const a = shiftPoint(start, change);
    const b = shiftPoint(end, change);
    return { line: a.line, character: a.character, endLine: b.line, endCharacter: b.character };
  }
  if (compare(start, change.start) <= 0 && compare(end, change.end) >= 0) {
    const b = shiftPoint(end, change);
    return { ...range, endLine: b.line, endCharacter: b.character };
  }
  return null;
}

/** Moves a line number past an edit; lines inside the edited text stay where the edit starts. */
export function shiftLine(line: number, change: TextChange): number {
  if (line <= change.start.line) return line;
  if (line > change.end.line) return line + change.text.split(/\r\n|\r|\n/).length - 1 - (change.end.line - change.start.line);
  return change.start.line;
}

/** Applies edits (all described against the text before any of them) to every range in a reading. */
export function applyChanges(doc: ReaderDocument, changes: readonly TextChange[]): void {
  // Applying the last edit first keeps the earlier ones' coordinates valid.
  const ordered = [...changes].sort((a, b) => compare(b.start, a.start));
  for (const change of ordered) {
    for (const utterance of doc.utterances) {
      if (utterance.range) utterance.range = shiftRange(utterance.range, change);
      for (const word of utterance.words) if (word.range) word.range = shiftRange(word.range, change);
      utterance.line = shiftLine(utterance.line, change);
      utterance.endLine = Math.max(utterance.line + 1, shiftLine(utterance.endLine, change));
    }
    for (const block of doc.blocks) {
      block.line = shiftLine(block.line, change);
      block.endLine = Math.max(block.line + 1, shiftLine(block.endLine, change));
    }
  }
}

const endsBefore = (range: SourceRange, point: Point) => range.endLine < point.line || (range.endLine === point.line && range.endCharacter <= point.character);
const startsAfter = (range: SourceRange, point: Point) => range.line > point.line || (range.line === point.line && range.character >= point.character);

/** The passage and word to read from for a position in the document (-1 for the start of the passage). */
export function locate(doc: ReaderDocument, point: Point): { index: number; word: number } {
  const { utterances } = doc;
  let index = utterances.findIndex(u => (u.range ? !endsBefore(u.range, point) : u.endLine > point.line));
  if (index < 0) index = Math.max(0, utterances.length - 1);
  const utterance = utterances[index];
  if (!utterance || (utterance.range && startsAfter(utterance.range, point))) return { index, word: -1 };
  const word = utterance.words.findIndex(w => w.range && !endsBefore(w.range, point));
  return { index, word: word > 0 ? word : -1 };
}
