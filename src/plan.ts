import type { ReaderDocument } from './document';
import { spokenLength } from './scheduler';

export interface PlanSettings {
  rate: number;
  /** Volume slider position, 0–100. */
  volume: number;
  followInEditor: boolean;
  highlightWords: boolean;
  skipBack: number;
  skipForward: number;
  tableMode: 'rows' | 'columns';
  codeBlocks: 'announce' | 'read' | 'skip';
}

export interface PlanStart {
  index: number;
  /** Seconds into the utterance. */
  offset: number;
  /** Word to start from once its timing is known, or -1. */
  word: number;
  autoplay: boolean;
}

/** What the player needs to know about a document: timing estimates and structure, never its text. */
export function planMessage(doc: ReaderDocument, revision: number, start: PlanStart, settings: PlanSettings, title: string, selection: boolean) {
  return {
    type: 'plan', revision, title, selection, start, settings,
    utterances: doc.utterances.map(u => ({ c: spokenLength(u), b: u.block, p: u.pauseAfter, n: u.words.length })),
    blocks: doc.blocks.map(block => ({ k: block.kind, f: block.first, t: block.heading?.text, l: block.heading?.level }))
  };
}
