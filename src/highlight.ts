import * as vscode from 'vscode';
import type { SourceRange } from './document';

export type Detached = false | 'above' | 'below';

const toRange = (range: SourceRange) => new vscode.Range(range.line, range.character, range.endLine, range.endCharacter);

/**
 * Highlights the sentence and word being read in the Markdown editor and keeps them in view,
 * until the listener scrolls away to look at something else.
 */
export class EditorHighlight implements vscode.Disposable {
  private readonly sentenceDecoration = vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor('clearMarkdown.readingBackground'),
    overviewRulerColor: new vscode.ThemeColor('clearMarkdown.readingBackground'),
    overviewRulerLane: vscode.OverviewRulerLane.Center,
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed
  });
  private readonly wordDecoration = vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor('clearMarkdown.readingWordBackground'),
    borderRadius: '3px',
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed
  });
  private uri: string | undefined;
  private sentence: vscode.Range | undefined;
  private word: vscode.Range | undefined;
  private follow = true;
  private words = true;
  private detached: Detached = false;
  /** Visible-range changes before this time come from our own scrolling. */
  private ownScrollUntil = 0;
  private readonly changed = new vscode.EventEmitter<Detached>();
  /** Fires when the listener scrolls away from the reading position, or back to it. */
  readonly onDidChangeDetached = this.changed.event;
  private readonly disposables: vscode.Disposable[] = [];

  constructor() {
    this.disposables.push(
      this.changed,
      vscode.window.onDidChangeVisibleTextEditors(() => this.render(true)),
      vscode.window.onDidChangeTextEditorVisibleRanges(event => this.scrolled(event.textEditor))
    );
  }

  private editors(): vscode.TextEditor[] {
    return this.uri ? vscode.window.visibleTextEditors.filter(editor => editor.document.uri.toString() === this.uri) : [];
  }

  configure(options: { follow: boolean; words: boolean }): void {
    const changed = options.follow !== this.follow || options.words !== this.words;
    this.follow = options.follow;
    this.words = options.words;
    if (!this.follow) this.setDetached(false);
    if (changed) this.render(this.follow);
  }

  /** Shows the reading position; scrolls to it when the sentence changed and the listener is following. */
  show(uri: vscode.Uri, sentence: SourceRange | null, word: SourceRange | null, scroll = true): void {
    const key = uri.toString();
    const moved = key !== this.uri || !sameRange(sentence ? toRange(sentence) : undefined, this.sentence);
    if (key !== this.uri) {
      this.clear();
      this.uri = key;
    }
    this.sentence = sentence ? toRange(sentence) : undefined;
    this.word = word ? toRange(word) : undefined;
    this.render(moved && scroll);
  }

  /** Follows the reading position again and scrolls to it. */
  backToReading(): void {
    this.setDetached(false);
    for (const editor of this.editors()) this.reveal(editor, true);
  }

  get isDetached(): Detached {
    return this.detached;
  }

  /** The text currently highlighted, for tests and diagnostics. */
  highlighted(): { sentenceText?: string; wordText?: string; editors: number } {
    const editor = this.editors()[0];
    return {
      sentenceText: editor && this.sentence ? editor.document.getText(this.sentence) : undefined,
      wordText: editor && this.word && this.words ? editor.document.getText(this.word) : undefined,
      editors: this.editors().length
    };
  }

  clear(): void {
    for (const editor of this.editors()) {
      editor.setDecorations(this.sentenceDecoration, []);
      editor.setDecorations(this.wordDecoration, []);
    }
    this.uri = undefined;
    this.sentence = undefined;
    this.word = undefined;
    this.setDetached(false);
  }

  private render(scroll: boolean): void {
    for (const editor of this.editors()) {
      editor.setDecorations(this.sentenceDecoration, this.sentence ? [this.sentence] : []);
      editor.setDecorations(this.wordDecoration, this.word && this.words ? [this.word] : []);
      if (scroll && this.follow && !this.detached) this.reveal(editor, false);
    }
  }

  private inView(editor: vscode.TextEditor): boolean {
    const range = this.sentence;
    if (!range) return true;
    const visible = editor.visibleRanges;
    return visible.some(r => r.contains(range.start)) && visible.some(r => r.contains(range.end));
  }

  private reveal(editor: vscode.TextEditor, force: boolean): void {
    if (!this.sentence || (!force && this.inView(editor))) return;
    this.ownScrollUntil = Date.now() + 500;
    editor.revealRange(this.sentence, vscode.TextEditorRevealType.InCenter);
  }

  private scrolled(editor: vscode.TextEditor): void {
    if (!this.follow || !this.sentence || editor.document.uri.toString() !== this.uri) return;
    if (Date.now() < this.ownScrollUntil) return;
    if (this.inView(editor)) this.setDetached(false);
    else {
      const top = editor.visibleRanges[0]?.start;
      this.setDetached(top && this.sentence.start.isBefore(top) ? 'above' : 'below');
    }
  }

  private setDetached(value: Detached): void {
    if (value === this.detached) return;
    this.detached = value;
    this.changed.fire(value);
  }

  dispose(): void {
    this.clear();
    this.sentenceDecoration.dispose();
    this.wordDecoration.dispose();
    this.disposables.forEach(disposable => disposable.dispose());
  }
}

function sameRange(a: vscode.Range | undefined, b: vscode.Range | undefined): boolean {
  return a === b || (!!a && !!b && a.isEqual(b));
}
