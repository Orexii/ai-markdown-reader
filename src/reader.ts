import * as vscode from 'vscode';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { buildDocument, type ReaderDocument } from './document';
import { Scheduler } from './scheduler';
import { planMessage } from './plan';
import type { SpeechEngine } from './engine/client';
import { MODELS, VOICES, voiceInfo } from './model';
import { dictionaryFrom } from './engine/pronounce';
import { describeBlock } from './copilot';
import { readerMarkup } from './markup';
import type { Services, Settings } from './services';

type EngineState = 'loading' | 'ready' | 'missing' | 'downloading' | 'error';
export type Start = 'resume' | 'top' | { line: number };

export interface OpenOptions {
  document: vscode.TextDocument;
  /** Selected text to read instead of the whole document. */
  selection?: vscode.Selection;
  start: Start;
  autoplay: boolean;
}

interface Message {
  type: string;
  revision?: number;
  indices?: number[];
  index?: number;
  playing?: boolean;
  elapsed?: number;
  total?: number;
  key?: string;
  value?: unknown;
  href?: string;
  block?: number;
  text?: string;
  event?: string;
}

export class ReaderSession implements vscode.Disposable {
  static readonly sessions = new Set<ReaderSession>();
  static active: ReaderSession | undefined;

  private readonly panel: vscode.WebviewPanel;
  private uri: vscode.Uri;
  private doc: ReaderDocument;
  private settings: Settings;
  private revision = 0;
  private engine: SpeechEngine | undefined;
  private scheduler: Scheduler | undefined;
  private state: EngineState = 'loading';
  private stateMessage = '';
  private progress = 0;
  private kind: 'natural' | 'system';
  private voices: { id: string; label: string }[] = [];
  private voice = '';
  private index = 0;
  private playing = false;
  private elapsed = 0;
  private total = 0;
  private readonly overrides = new Map<number, string>();
  private download: AbortController | undefined;
  private saveTimer: NodeJS.Timeout | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private disposed = false;
  private start: { index: number; offset: number; autoplay: boolean };
  /** Events reported by the webview; used by the integration test to confirm real playback. */
  readonly events: string[] = [];

  private constructor(private readonly services: Services, private options: OpenOptions) {
    this.uri = options.document.uri;
    this.settings = services.settings();
    this.kind = this.settings.engine;
    this.doc = this.build();
    this.start = { index: this.startIndex(options.start), offset: 0, autoplay: options.autoplay };
    const media = vscode.Uri.joinPath(services.context.extensionUri, 'media');
    this.panel = vscode.window.createWebviewPanel('clearMarkdown.reader', `Read: ${path.posix.basename(this.uri.path)}`,
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [media] });
    this.panel.iconPath = vscode.Uri.joinPath(media, 'icon.svg');
    this.panel.webview.html = this.html();
    services.acquire();
    this.disposables.push(
      this.panel.webview.onDidReceiveMessage((message: unknown) => {
        if (!message || typeof message !== 'object' || typeof (message as Message).type !== 'string') return;
        void this.handle(message as Message).catch(error => this.fail(error));
      }),
      this.panel.onDidChangeViewState(() => {
        if (this.panel.active) ReaderSession.focus(this);
      }),
      this.panel.onDidDispose(() => this.dispose()),
      vscode.workspace.onDidChangeTextDocument(event => {
        if (event.document.uri.toString() === this.uri.toString() && event.contentChanges.length) this.post({ type: 'stale' });
      }),
      vscode.window.onDidChangeVisibleTextEditors(() => this.decorate()),
      vscode.workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration('clearMarkdown')) void this.configurationChanged(event).catch(error => this.fail(error));
      })
    );
    ReaderSession.sessions.add(this);
    ReaderSession.focus(this);
  }

  /**
   * Opens the reader, reusing the existing panel: VS Code only lets a webview play sound after a
   * gesture inside it, so keeping one panel means later documents can start playing immediately.
   */
  static open(services: Services, options: OpenOptions): ReaderSession {
    const existing = ReaderSession.active ?? [...ReaderSession.sessions][0];
    if (existing) {
      existing.load(options);
      return existing;
    }
    return new ReaderSession(services, options);
  }

  private load(options: OpenOptions): void {
    clearTimeout(this.saveTimer);
    const previous = { options: this.options, uri: this.uri, doc: this.doc, settings: this.settings };
    this.options = options;
    this.uri = options.document.uri;
    this.settings = this.services.settings();
    try {
      this.doc = buildDocument(this.text().text, { tableMode: this.settings.tableMode, codeBlocks: this.settings.codeBlocks, lineOffset: this.text().offset });
      if (!this.doc.utterances.length) throw new Error('There is no readable text in this Markdown.');
    } catch (error) {
      Object.assign(this, previous);
      throw error;
    }
    void this.savePosition(previous.uri, previous.options, previous.doc);
    this.clearDecorations(previous.uri);
    this.overrides.clear();
    this.events.length = 0;
    this.index = 0;
    this.playing = false;
    this.start = { index: this.startIndex(options.start), offset: 0, autoplay: options.autoplay };
    this.panel.title = `Read: ${path.posix.basename(this.uri.path)}`;
    this.panel.reveal(undefined, false);
    this.renew();
    this.sendPlan();
    ReaderSession.focus(this);
  }

  private clearDecorations(uri: vscode.Uri): void {
    for (const editor of vscode.window.visibleTextEditors) {
      if (editor.document.uri.toString() === uri.toString()) editor.setDecorations(this.services.decoration, []);
    }
  }

  private static focus(session: ReaderSession | undefined): void {
    ReaderSession.active = session;
    void vscode.commands.executeCommand('setContext', 'clearMarkdown.playerActive', !!session);
    session?.updateStatus();
    session?.decorate();
  }

  private text(): { text: string; offset: number } {
    const selection = this.options.selection;
    if (selection && !selection.isEmpty) return { text: this.options.document.getText(selection), offset: selection.start.line };
    return { text: this.options.document.getText(), offset: 0 };
  }

  private build(): ReaderDocument {
    const { text, offset } = this.text();
    const doc = buildDocument(text, { tableMode: this.settings.tableMode, codeBlocks: this.settings.codeBlocks, lineOffset: offset, overrides: this.overrides });
    if (!doc.utterances.length) throw new Error('There is no readable text in this Markdown.');
    return doc;
  }

  private startIndex(start: Start): number {
    const utterances = this.doc.utterances;
    const byLine = (line: number) => {
      const found = utterances.findIndex(u => u.endLine > line);
      return found < 0 ? 0 : found;
    };
    if (start === 'top') return 0;
    if (start === 'resume') {
      const saved = this.options.selection ? undefined : this.services.position(this.uri);
      if (!saved) return 0;
      const index = utterances[saved.index]?.line === saved.line ? saved.index : byLine(saved.line);
      return index >= utterances.length - 1 ? 0 : index;
    }
    return byLine(start.line);
  }

  private post(message: object): void {
    if (!this.disposed) void this.panel.webview.postMessage(message);
  }

  private fail(error: unknown): void {
    if (this.disposed) return;
    const message = error instanceof Error ? error.message : String(error);
    this.services.output.appendLine(message);
    this.post({ type: 'error', message });
  }

  private sendPlan(): void {
    this.post(planMessage(this.doc, this.revision, this.start, {
      rate: this.settings.rate, followInEditor: this.settings.followInEditor, highlightWords: this.settings.highlightWords,
      skipBack: this.settings.skipBack, skipForward: this.settings.skipForward, tableMode: this.settings.tableMode,
      codeBlocks: this.settings.codeBlocks, selection: !!this.options.selection, title: path.posix.basename(this.uri.path)
    }, this.overrides));
    this.sendEngine();
  }

  private sendEngine(): void {
    this.post({
      type: 'engine', revision: this.revision, state: this.state, message: this.stateMessage, progress: this.progress,
      kind: this.kind, voices: this.voices, voice: this.voice, sizeMB: Math.round(MODELS[this.settings.quality].size / 1e6)
    });
  }

  private setState(state: EngineState, message = ''): void {
    this.state = state;
    this.stateMessage = message;
    this.sendEngine();
  }

  /** Starts a new audio generation: any change of voice, engine or narration invalidates cached audio. */
  private renew(): void {
    this.scheduler?.dispose();
    this.revision++;
    const engine = this.engine;
    if (!engine) return;
    const revision = this.revision;
    this.scheduler = new Scheduler({
      engine, utterances: this.doc.utterances, voice: this.voice,
      dictionary: [...dictionaryFrom(this.settings.pronunciations)],
      deliver: (index, segment) => {
        if (revision === this.revision) this.post({ type: 'audio', revision, index, wav: segment.wav, duration: segment.duration, wordTimes: segment.wordTimes });
      },
      fail: (index, error) => {
        if (revision !== this.revision) return;
        this.services.output.appendLine(`Speech failed at passage ${index + 1}: ${error.message}`);
        this.post({ type: 'error', revision, index, message: `Speech failed: ${error.message}` });
      }
    });
  }

  private async selectEngine(): Promise<void> {
    this.settings = this.services.settings();
    if (this.settings.engine === 'system') return this.useSystem();
    const { store } = this.services;
    if (!await store.hasModel(this.settings.quality) || !await store.hasVoice(this.settings.naturalVoice)) {
      this.kind = 'natural';
      this.engine = undefined;
      this.renew();
      this.setState('missing');
      return;
    }
    return this.useNatural();
  }

  private async useNatural(): Promise<void> {
    this.kind = 'natural';
    this.voices = VOICES.map(v => ({ id: v.id, label: `${v.name} · ${v.accent === 'British' ? 'UK' : 'US'} ${v.gender.toLowerCase()} · ${v.grade}` }));
    this.voice = this.settings.naturalVoice;
    const engine = this.services.naturalEngine(this.settings.quality, this.services.threads(this.settings.threads));
    this.engine = undefined;
    this.renew();
    this.setState('loading');
    try {
      await engine.start();
    } catch (error) {
      this.setState('error', `The natural voice could not start: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    if (this.disposed) return;
    this.engine = engine;
    this.renew();
    this.setState('ready');
  }

  private async useSystem(): Promise<void> {
    this.kind = 'system';
    this.engine = undefined;
    this.renew();
    this.setState('loading');
    try {
      const { engine, voices } = await this.services.systemEngine();
      if (this.disposed) return;
      this.voices = voices;
      this.voice = voices.some(v => v.id === this.settings.systemVoice) ? this.settings.systemVoice : '';
      this.engine = engine;
      this.renew();
      this.setState('ready');
    } catch (error) {
      this.setState('error', error instanceof Error ? error.message : String(error));
    }
  }

  private async install(): Promise<void> {
    if (this.download) return;
    const controller = new AbortController();
    this.download = controller;
    this.progress = 0;
    this.setState('downloading');
    let last = 0;
    try {
      await this.services.store.install(this.settings.quality, this.settings.naturalVoice, (received, total) => {
        const percent = total ? Math.floor((received / total) * 100) : 0;
        if (percent !== last) {
          last = percent;
          this.progress = percent;
          this.sendEngine();
        }
      }, controller.signal);
      await this.services.update('engine', 'natural');
      this.settings = this.services.settings();
      await this.useNatural();
    } catch (error) {
      this.setState('missing', error instanceof Error ? error.message : String(error));
    } finally {
      this.download = undefined;
    }
  }

  private async changeVoice(voice: string): Promise<void> {
    if (this.kind === 'natural') {
      if (!voiceInfo(voice)) throw new Error('Choose a voice from the list.');
      if (!await this.services.store.hasVoice(voice)) {
        this.setState('loading', 'Downloading voice…');
        try {
          await this.services.store.installVoice(voice, new AbortController().signal);
        } catch (error) {
          // Keep reading with the current voice if the new one cannot be downloaded.
          this.setState('ready');
          throw error;
        }
      }
      this.voice = voice;
      await this.services.update('naturalVoice', voice);
    } else {
      if (voice && !this.voices.some(v => v.id === voice)) throw new Error('Choose an installed voice from the list.');
      this.voice = voice;
      await this.services.update('systemVoice', voice);
    }
    this.settings = this.services.settings();
    this.renew();
    this.setState('ready');
  }

  /** Rebuilds narration (after a setting change, an edit or a Copilot description) and keeps the listener's place. */
  private rebuild(): void {
    const block = this.doc.utterances[this.index]?.block;
    this.settings = this.services.settings();
    this.doc = this.build();
    const first = block === undefined ? -1 : this.doc.blocks[block]?.first ?? -1;
    this.start = { index: first >= 0 ? first : Math.min(this.index, this.doc.utterances.length - 1), offset: 0, autoplay: this.playing };
    this.renew();
    this.sendPlan();
  }

  private async handle(message: Message): Promise<void> {
    switch (message.type) {
      case 'ready':
        this.sendPlan();
        await this.selectEngine();
        break;
      case 'need':
        if (message.revision === this.revision && Array.isArray(message.indices)) this.scheduler?.need(message.indices.slice(0, 60));
        break;
      case 'position': {
        const changed = message.index !== this.index;
        this.index = Math.max(0, Math.min(Number(message.index) || 0, this.doc.utterances.length - 1));
        this.playing = !!message.playing;
        this.elapsed = Number(message.elapsed) || 0;
        this.total = Number(message.total) || 0;
        if (changed) this.decorate();
        this.updateStatus();
        this.scheduleSave();
        break;
      }
      case 'event':
        if (typeof message.event === 'string') this.events.push(message.event);
        break;
      case 'setting':
        await this.setting(String(message.key), message.value);
        break;
      case 'install':
        await this.install();
        break;
      case 'cancelInstall':
        this.download?.abort();
        break;
      case 'useSystem':
        // Set the kind first so the resulting configuration event does not switch engines a second time.
        this.kind = 'system';
        await this.services.update('engine', 'system');
        this.settings = this.services.settings();
        await this.useSystem();
        break;
      case 'useNatural':
        this.kind = 'natural';
        await this.services.update('engine', 'natural');
        await this.selectEngine();
        break;
      case 'retry':
        await this.selectEngine();
        break;
      case 'reveal':
        await this.reveal(Number(message.index));
        break;
      case 'openLink':
        if (typeof message.href === 'string' && /^(https?:|mailto:)/i.test(message.href)) await vscode.env.openExternal(vscode.Uri.parse(message.href));
        break;
      case 'refresh':
        this.rebuild();
        break;
      case 'describe':
        await this.describe(Number(message.block));
        break;
      case 'useDescription':
        if (typeof message.text === 'string' && this.doc.blocks[Number(message.block)]) {
          this.overrides.set(Number(message.block), message.text);
          this.rebuild();
        }
        break;
      case 'restore':
        this.overrides.delete(Number(message.block));
        this.rebuild();
        break;
    }
  }

  private async setting(key: string, value: unknown): Promise<void> {
    switch (key) {
      case 'rate':
        if (typeof value === 'number' && value >= 0.5 && value <= 3) await this.services.update('rate', value);
        break;
      case 'voice':
        if (typeof value === 'string') await this.changeVoice(value);
        break;
      // These apply through configurationChanged, which also handles edits made in the Settings editor.
      case 'tableMode':
        if (value === 'rows' || value === 'columns') await this.services.update('tableMode', value);
        break;
      case 'codeBlocks':
        if (value === 'announce' || value === 'read' || value === 'skip') await this.services.update('codeBlocks', value);
        break;
      case 'followInEditor':
      case 'highlightWords':
        if (typeof value === 'boolean') await this.services.update(key, value);
        break;
    }
  }

  /** Applies settings changed outside the reader (Settings editor, settings.json or another window). */
  private async configurationChanged(event: vscode.ConfigurationChangeEvent): Promise<void> {
    const before = this.settings;
    const after = this.services.settings();
    const changed = (key: string) => event.affectsConfiguration(`clearMarkdown.${key}`);
    this.settings = after;
    if (changed('engine') || changed('naturalQuality') || changed('threads')) {
      if (after.engine !== this.kind || after.quality !== before.quality || after.threads !== before.threads) await this.selectEngine();
    } else if ((changed('naturalVoice') || changed('systemVoice')) && this.state === 'ready') {
      const voice = this.kind === 'natural' ? after.naturalVoice : after.systemVoice;
      if (voice !== this.voice) await this.changeVoice(voice);
    }
    if (changed('tableMode') || changed('codeBlocks')) {
      if (after.tableMode !== before.tableMode || after.codeBlocks !== before.codeBlocks) this.rebuild();
    } else if (changed('pronunciations')) {
      this.renew();
      this.sendEngine();
    }
    if (changed('rate') || changed('highlightWords') || changed('followInEditor') || changed('skipBackSeconds') || changed('skipForwardSeconds')) {
      this.post({ type: 'settings', rate: after.rate, highlightWords: after.highlightWords, followInEditor: after.followInEditor, skipBack: after.skipBack, skipForward: after.skipForward });
      this.decorate();
    }
  }

  private async describe(block: number): Promise<void> {
    const info = this.doc.blocks[block];
    if (!info || (info.kind !== 'table' && info.kind !== 'code')) return;
    const document = this.options.document;
    const range = new vscode.Range(info.line, 0, Math.min(info.endLine, document.lineCount), 0);
    try {
      const text = await describeBlock(this.services.context, info.kind, document.getText(range));
      if (text) this.post({ type: 'description', block, text });
      else this.post({ type: 'description', block });
    } catch (error) {
      this.post({ type: 'description', block, error: error instanceof Error ? error.message : String(error) });
    }
  }

  private async reveal(index: number): Promise<void> {
    const utterance = this.doc.utterances[index];
    if (!utterance) return;
    const visible = vscode.window.visibleTextEditors.find(editor => editor.document.uri.toString() === this.uri.toString());
    const editor = await vscode.window.showTextDocument(this.options.document, { viewColumn: visible?.viewColumn ?? vscode.ViewColumn.One });
    const line = Math.min(utterance.line, editor.document.lineCount - 1);
    const range = editor.document.lineAt(line).range;
    editor.selection = new vscode.Selection(range.start, range.start);
    editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  }

  /** Highlights the block being read in the source editor and keeps it in view. */
  private decorate(): void {
    if (ReaderSession.active !== this) return;
    const utterance = this.doc.utterances[this.index];
    for (const editor of vscode.window.visibleTextEditors) {
      if (editor.document.uri.toString() !== this.uri.toString()) continue;
      if (!utterance || !this.settings.followInEditor) {
        editor.setDecorations(this.services.decoration, []);
        continue;
      }
      const last = editor.document.lineCount - 1;
      const start = Math.min(utterance.line, last);
      const end = Math.max(start, Math.min(utterance.endLine - 1, last));
      const range = new vscode.Range(start, 0, end, editor.document.lineAt(end).text.length);
      editor.setDecorations(this.services.decoration, [range]);
      if (this.playing && !editor.visibleRanges.some(visible => visible.contains(range.start))) {
        editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
      }
    }
  }

  private updateStatus(): void {
    if (ReaderSession.active !== this) return;
    const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
    const status = this.services.status;
    status.text = `${this.playing ? '$(debug-pause)' : '$(play)'} ${clock(this.elapsed)} / ${clock(this.total)}`;
    status.tooltip = `Clear Markdown Reader: ${this.playing ? 'pause' : 'play'} ${path.posix.basename(this.uri.path)}`;
    status.show();
  }

  private scheduleSave(): void {
    if (this.options.selection) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => void this.save(), 2000);
  }

  private save(): Promise<void> {
    return this.savePosition(this.uri, this.options, this.doc);
  }

  private async savePosition(uri: vscode.Uri, options: OpenOptions, doc: ReaderDocument): Promise<void> {
    if (options.selection) return;
    const utterance = doc.utterances[this.index];
    const finished = this.index >= doc.utterances.length - 1 && !this.playing;
    await this.services.savePosition(uri, utterance && !finished
      ? { line: utterance.line, index: this.index, total: doc.utterances.length, at: Date.now() }
      : undefined);
  }

  /** State for integration tests and diagnostics. */
  snapshot(): { events: string[]; playing: boolean; index: number; total: number; state: string; kind: string } {
    return { events: [...this.events], playing: this.playing, index: this.index, total: this.doc.utterances.length, state: this.state, kind: this.kind };
  }

  command(action: string): void {
    this.post({ type: 'command', action });
  }

  show(): void {
    this.panel.reveal(undefined, true);
  }

  private html(): string {
    const webview = this.panel.webview;
    const media = (file: string) => webview.asWebviewUri(vscode.Uri.joinPath(this.services.context.extensionUri, 'media', file)).toString();
    return readerMarkup({
      cspSource: webview.cspSource, nonce: randomBytes(18).toString('base64'), css: media('reader.css'), script: media('reader.js'),
      skipBack: this.settings.skipBack, skipForward: this.settings.skipForward
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    clearTimeout(this.saveTimer);
    void this.save();
    this.download?.abort();
    this.scheduler?.dispose();
    this.clearDecorations(this.uri);
    this.disposables.forEach(disposable => disposable.dispose());
    this.panel.dispose();
    this.services.release();
    ReaderSession.sessions.delete(this);
    if (ReaderSession.active === this) {
      const next = [...ReaderSession.sessions].at(-1);
      ReaderSession.focus(next);
      if (!next) this.services.status.hide();
    }
  }
}
