import * as vscode from 'vscode';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { narrate, type Segment } from './narration';
import { NativeSpeech } from './speech';
import { proposeNarration } from './copilot';

interface ReaderMessage {
  type: string;
  index?: number;
  request?: number;
  voice?: string;
  mode?: string;
}

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('Clear Markdown Reader');
  context.subscriptions.push(output);
  const report = (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    output.appendLine(message);
    void vscode.window.showErrorMessage(`Clear Markdown Reader: ${message}`);
  };
  for (const [command, selected] of [
    ['clearMarkdown.read', false], ['clearMarkdown.readSelection', true]
  ] as const) {
    context.subscriptions.push(vscode.commands.registerCommand(command, async () => {
      try {
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.document.languageId !== 'markdown') {
          throw new Error('Open a Markdown file in the text editor first.');
        }
        if (selected && editor.selection.isEmpty) throw new Error('Select the Markdown you want to hear first.');
        const text = selected ? editor.document.getText(editor.selection) : editor.document.getText();
        const offset = selected ? editor.selection.start.line : 0;
        await Reader.open(context, editor.document, text, offset, output, report);
      } catch (error) { report(error); }
    }));
  }
}

class Reader {
  private readonly original: Segment[];
  private segments: Segment[];
  private proposed: Segment[] | undefined;
  private aiBusy = false;
  private voice: string;
  private tableMode: 'rows' | 'columns';
  private revision = 0;
  private controller = new AbortController();
  private readonly audio = new Map<number, Promise<string>>();
  private readonly pending = new Set<Promise<string>>();
  private disposed = false;

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly document: vscode.TextDocument,
    private readonly markdown: string,
    private readonly offset: number,
    private readonly speech: NativeSpeech,
    private readonly voices: { id: string; label: string }[],
    private readonly directory: string,
    private readonly output: vscode.OutputChannel,
    private readonly report: (error: unknown) => void
  ) {
    const config = vscode.workspace.getConfiguration('clearMarkdown', document.uri);
    this.voice = config.get<string>('voice', '');
    this.tableMode = config.get<'rows' | 'columns'>('tableMode', 'rows');
    if (this.voice && !voices.some(voice => voice.id === this.voice)) {
      output.appendLine('The saved voice is not installed on this desktop. Using the system default.');
      void vscode.window.showWarningMessage('Clear Markdown Reader: your saved voice is not installed here. Using the system default; choose another voice in the reader.');
      this.voice = '';
    }
    this.original = narrate(markdown, {
      tableMode: this.tableMode,
      codeBlocks: config.get<'announce' | 'read'>('codeBlocks', 'announce')
    }).map(segment => ({ ...segment, line: segment.line + offset }));
    this.segments = this.original;
  }

  static async open(
    context: vscode.ExtensionContext, document: vscode.TextDocument, markdown: string, offset: number,
    output: vscode.OutputChannel, report: (error: unknown) => void
  ): Promise<void> {
    if (!narrate(markdown).length) throw new Error('There is no readable Markdown in this selection or document.');
    const speech = await NativeSpeech.create(context.asAbsolutePath('scripts/speak.ps1'));
    const voices = await speech.voices();
    const directory = await mkdtemp(path.join(os.tmpdir(), 'clear-markdown-'));
    const panel = vscode.window.createWebviewPanel(
      'clearMarkdown.reader', `Read: ${path.posix.basename(document.uri.path)}`,
      vscode.ViewColumn.Beside, {
        enableScripts: true, retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media'), vscode.Uri.file(directory)]
      }
    );
    const reader = new Reader(panel, document, markdown, offset, speech, voices, directory, output, report);
    const messages = panel.webview.onDidReceiveMessage((message: unknown) => {
      if (!message || typeof message !== 'object' || !('type' in message) || typeof message.type !== 'string') {
        report(new Error('Invalid reader message.'));
        return;
      }
      void reader.handle(message as ReaderMessage).catch(error => {
        if (!reader.disposed) {
          report(error);
          void panel.webview.postMessage({
            type: 'error', message: error instanceof Error ? error.message : String(error),
            request: message.type === 'audio' && 'request' in message ? message.request : undefined
          });
        }
      });
    });
    const dispose = panel.onDidDispose(() => {
      reader.disposed = true;
      reader.controller.abort();
      messages.dispose();
      dispose.dispose();
      void Promise.allSettled([...reader.pending])
        .then(() => rm(directory, { recursive: true, force: true })).catch(report);
    });
    context.subscriptions.push(panel);
    panel.webview.html = reader.html(context);
  }

  private sendPlan(): void {
    void this.panel.webview.postMessage({
      type: 'plan', segments: this.segments, voices: this.voices, voice: this.voice,
      rate: vscode.workspace.getConfiguration('clearMarkdown').get<number>('rate', 1),
      revision: this.revision, ai: this.segments !== this.original,
      tableMode: this.tableMode
    });
  }

  private reset(segments: Segment[]): void {
    this.controller.abort();
    this.controller = new AbortController();
    this.audio.clear();
    this.segments = segments;
    this.revision++;
    this.sendPlan();
  }

  private async audioFor(index: number): Promise<string> {
    const cached = this.audio.get(index);
    if (cached) return cached;
    const segment = this.segments[index];
    if (!segment) throw new Error('Requested narration passage does not exist.');
    const file = path.join(this.directory, `${randomUUID()}.wav`);
    const voice = this.voice;
    const signal = this.controller.signal;
    const promise = this.speech.synthesize(segment.text, voice, file, signal).then(() => file);
    this.pending.add(promise);
    this.audio.set(index, promise);
    // Keep a small moving window; synthesized text/audio is otherwise removed when the panel closes.
    for (const [oldIndex, oldPromise] of this.audio) {
      if (Math.abs(oldIndex - index) > 3) {
        this.audio.delete(oldIndex);
        void oldPromise.then(oldFile => rm(oldFile, { force: true }), () => undefined)
          .catch(error => this.output.appendLine(`Audio cache cleanup failed: ${String(error)}`));
      }
    }
    try { return await promise; }
    catch (error) {
      if (this.audio.get(index) === promise) this.audio.delete(index);
      throw error;
    } finally { this.pending.delete(promise); }
  }

  private async handle(message: ReaderMessage): Promise<void> {
    switch (message.type) {
      case 'ready': this.sendPlan(); break;
      case 'audio': {
        if (!Number.isInteger(message.index) || !Number.isInteger(message.request)) throw new Error('Invalid audio request.');
        const index = message.index!;
        const revision = this.revision;
        const signal = this.controller.signal;
        try {
          const file = await this.audioFor(index);
          if (this.disposed || revision !== this.revision) return;
          await this.panel.webview.postMessage({
            type: 'audio', index, request: message.request, revision,
            uri: this.panel.webview.asWebviewUri(vscode.Uri.file(file)).toString()
          });
          if (index + 1 < this.segments.length) {
            void this.audioFor(index + 1).catch(error => {
              if (!signal.aborted) this.output.appendLine(`Prefetch failed; playback will retry: ${String(error)}`);
            });
          }
        } catch (error) {
          if (!signal.aborted) throw error;
        }
        break;
      }
      case 'voice': {
        if (typeof message.voice !== 'string' ||
            (message.voice !== '' && !this.voices.some(voice => voice.id === message.voice))) {
          throw new Error('Choose an installed voice from the list.');
        }
        this.voice = message.voice;
        await vscode.workspace.getConfiguration('clearMarkdown').update('voice', this.voice, vscode.ConfigurationTarget.Global);
        this.reset(this.segments);
        break;
      }
      case 'tableMode': {
        if (message.mode !== 'rows' && message.mode !== 'columns') throw new Error('Unknown table narration mode.');
        await vscode.workspace.getConfiguration('clearMarkdown', this.document.uri)
          .update('tableMode', message.mode, vscode.ConfigurationTarget.Global);
        this.tableMode = message.mode;
        const config = vscode.workspace.getConfiguration('clearMarkdown', this.document.uri);
        const fresh = narrate(this.markdown, {
          tableMode: message.mode, codeBlocks: config.get<'announce' | 'read'>('codeBlocks', 'announce')
        }).map(segment => ({ ...segment, line: segment.line + this.offset }));
        this.original.splice(0, this.original.length, ...fresh);
        this.proposed = undefined;
        this.reset(this.original);
        break;
      }
      case 'reveal': {
        if (!Number.isInteger(message.index)) throw new Error('Invalid source passage.');
        const segment = this.segments[message.index!];
        if (!segment) throw new Error('Source passage no longer exists.');
        const editor = await vscode.window.showTextDocument(this.document, { viewColumn: vscode.ViewColumn.One, preserveFocus: true });
        const line = Math.min(segment.line, editor.document.lineCount - 1);
        const range = editor.document.lineAt(line).range;
        editor.selection = new vscode.Selection(range.start, range.end);
        editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
        break;
      }
      case 'original':
        this.proposed = undefined;
        this.reset(this.original);
        break;
      case 'applyAI':
        if (!this.proposed) throw new Error('There is no AI proposal to apply.');
        this.reset(this.proposed);
        this.proposed = undefined;
        break;
      case 'discardAI':
        this.proposed = undefined;
        break;
      case 'ai': {
        if (this.aiBusy) throw new Error('An AI request is already in progress.');
        this.aiBusy = true;
        const revision = this.revision;
        try {
          const proposal = await proposeNarration(this.segments);
          if (!proposal || this.disposed) {
            void this.panel.webview.postMessage({ type: 'aiDone' });
            return;
          }
          if (revision !== this.revision) throw new Error('Narration changed during the AI request. Request a new proposal.');
          this.proposed = proposal;
          void this.panel.webview.postMessage({ type: 'proposal', original: this.segments, segments: proposal });
        } finally { this.aiBusy = false; }
        break;
      }
      default: throw new Error(`Unknown reader action: ${message.type}`);
    }
  }

  private html(context: vscode.ExtensionContext): string {
    const nonce = randomBytes(18).toString('base64');
    const webview = this.panel.webview;
    const resource = (file: string) => webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', file));
    return `<!doctype html>
<html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src ${webview.cspSource}; media-src ${webview.cspSource};">
<link href="${resource('reader.css')}" rel="stylesheet"><title>Clear Markdown Reader</title></head>
<body>
<header><h1>Clear Markdown Reader</h1><p>Structure-aware narration. Local speech. Your pace.</p></header>
<section class="controls" aria-label="Playback controls">
<button id="previous" title="Previous passage (Alt+Left)">Previous</button>
<button id="play" title="Play or pause (Space)">Play</button>
<button id="stop">Stop</button>
<button id="next" title="Next passage (Alt+Right)">Next</button>
<label>Speed <select id="rate"><option value="0.5">0.5x</option><option value="0.75">0.75x</option><option value="1">1x</option><option value="1.25">1.25x</option><option value="1.5">1.5x</option><option value="1.75">1.75x</option><option value="2">2x</option></select></label>
<label>Voice <select id="voice"><option value="">System default</option></select></label>
<label>Tables <select id="tableMode"><option value="rows">Row by row</option><option value="columns">Column by column</option></select></label>
</section>
<p id="status" role="status" aria-live="polite">Loading local voices...</p>
<p id="error" role="alert" hidden></p>
<section class="ai-controls" aria-label="Optional AI narration">
<button id="ai">Propose smoother narration with Copilot</button><button id="original" hidden>Restore original narration</button>
<p>Optional: sends text to your chosen Copilot model after confirmation. Review for factual changes before applying.</p>
</section>
<section id="proposal" hidden aria-label="Review AI proposal">
<h2>Review before applying</h2><p>AI can omit details or change meaning. Compare both versions. Nothing is spoken automatically.</p>
<div class="comparison"><div><h3>Current narration</h3><div id="before"></div></div><div><h3>Copilot proposal</h3><div id="after"></div></div></div>
<button id="apply">Apply proposal</button><button id="discard">Discard</button>
</section>
<main><h2>Narration</h2><p class="hint">Click a passage to start there. Use its Source button to reveal the Markdown. The reader is a snapshot; reopen it after editing.</p><ol id="passages" aria-label="Narration passages"></ol></main>
<audio id="audio" preload="auto"></audio>
<script nonce="${nonce}" src="${resource('reader.js')}"></script>
</body></html>`;
  }
}
