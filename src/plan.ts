import type { ReaderDocument } from './document';
import { spokenLength } from './scheduler';

export interface PlanSettings {
  rate: number;
  followInEditor: boolean;
  highlightWords: boolean;
  skipBack: number;
  skipForward: number;
  tableMode: 'rows' | 'columns';
  codeBlocks: 'announce' | 'read' | 'skip';
  selection: boolean;
  title?: string;
}

/** The compact form of a document sent to the reader webview. */
export function planMessage(doc: ReaderDocument, revision: number, start: { index: number; offset: number; autoplay: boolean },
  settings: PlanSettings, described: ReadonlySet<number> | ReadonlyMap<number, unknown> = new Set()) {
  return {
    type: 'plan', revision, html: doc.html, start, settings,
    utterances: doc.utterances.map(u => ({ h: u.highlight, w: u.words.map(word => word.target), c: spokenLength(u), b: u.block, p: u.pauseAfter })),
    blocks: doc.blocks.map((block, index) => ({ id: block.id, k: block.kind, f: block.first, t: block.heading?.text, l: block.heading?.level, ai: described.has(index) }))
  };
}
