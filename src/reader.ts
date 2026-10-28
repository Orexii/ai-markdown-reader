import * as vscode from 'vscode';
import * as path from 'node:path';
import { buildDocument, type ReaderDocument, type SourceRange } from './document';
import { Scheduler } from './scheduler';
import { planMessage, type PlanStart } from './plan';
import type { SpeechEngine } from './engine/client';
import { MODELS, VOICES, voiceInfo } from './model';
import { dictionaryFrom } from './engine/pronounce';
import { parseWav } from './engine/wav';
import { describeBlock } from './copilot';
import { applyChanges, locate, shiftRange, type TextChange } from './ranges';
import { isSpeed } from './speeds';
import type { Services, Settings } from './services';
import type { PlayerMessage, PlayerView } from './view';
import type { EditorHighlight } from './highlight';
import type { Controls } from './controls';
import type { PreviewPanels } from './previewPanel';

type EngineState = 'loading' | 'ready' | 'missing' | 'downloading' | 'error';
export type Start = 'resume' | 'top' | { line: number; character: number };

export interface OpenOptions {
  document: vscode.TextDocument;
  /** Text to read instead of the whole document. */
  selection?: vscode.Range;
  start: Start;
}

interface Reading {
  document: vscode.TextDocument;
  uri: vscode.Uri;
  title: string;
  /** The part of the document being read, or undefined for all of it. */
  selection: SourceRange | undefined;
  doc: ReaderDocument;
  /** Approved Copilot narration by block. */
  overrides: Map<number, string>;
  /** The document was edited after the narration was built. */
  stale: boolean;
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const toSource = (range: vscode.Range): SourceRange => ({ line: range.start.line, character: range.start.character, endLine: range.end.line, endCharacter: range.end.character });
const toRange = (range: SourceRange) => new vscode.Range(range.line, range.character, range.endLine, range.endCharacter);

/** Reads one Markdown document at a time: narration, speech, the player view and editor highlighting. */
export class Reader implements vscode.Disposable {
  private reading: Reading | undefined;
  private settings: Settings;
  private index = 0;
  private word = -1;
  private playing = false;
  private waiting = false;
  private elapsed = 0;
  private total = 0;
  private rate: number;
  /** Volume and mute as last reported by the player. */
  private volume = 100;
  private muted = false;
  private start: PlanStart = { index: 0, offset: 0, word: -1, autoplay: false };
  private revision = 0;
  private engine: SpeechEngine | undefined;
  private scheduler: Scheduler | undefined;
  private state: EngineState = 'loading';
  private stateMessage = '';
  private progress = 0;
  private kind: 'natural' | 'system';
  private voices: { id: string; label: string }[] = [];
  private voice = '';
  private download: AbortController | undefined;
  private saveTimer: NodeJS.Timeout | undefined;
  private acquired = false;
  private disposed = false;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly changed = new vscode.EventEmitter<void>();
  /** Fires when the document being read, or its Copilot descriptions, change. */
  readonly onDidChangeReading = this.changed.event;
  /** Diagnostic events reported by the player, used by the integration test. */
  readonly events: string[] = [];

  constructor(private readonly services: Services, private readonly view: PlayerView, private readonly highlight: EditorHighlight, private readonly controls: Controls,
    private readonly previews: PreviewPanels) {
    this.settings = services.settings();
    this.kind = this.settings.engine;
    this.rate = this.settings.rate;
    highlight.configure({ follow: this.settings.followInEditor, words: this.settings.highlightWords });
    previews.configure({ follow: this.settings.followInEditor, words: this.settings.highlightWords });
    this.disposables.push(
      this.changed,
      view.onMessage(message => void this.handle(message).catch(error => this.fail(error))),
      view.onDidClose(() => {
        this.playing = false;
        this.waiting = false;
        this.start.autoplay = false;
        this.updateControls();
      }),
      highlight.onDidChangeDetached(() => this.updateControls()),
      vscode.workspace.onDidChangeTextDocument(event => this.edited(event)),
      vscode.workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration('clearMarkdown')) void this.configurationChanged(event).catch(error => this.fail(error));
      })
    );
  }

  get active(): boolean {
    return !!this.reading;
  }

  isReading(uri: vscode.Uri): boolean {
    return this.reading?.uri.toString() === uri.toString();
  }

  /** Starts reading a document, or moves within it when it is already loaded. */
  async open(options: OpenOptions): Promise<void> {
    const current = this.reading;
    const selection = options.selection && !options.selection.isEmpty ? toSource(options.selection) : undefined;
    if (current && !current.stale && !selection && !current.selection && current.uri.toString() === options.document.uri.toString()) {
      // Reuse the narration and the audio already made for it.
      this.highlight.backToReading();
      this.previews.reveal(current.uri);
      if (options.start === 'top') this.command('seek', { index: 0, word: -1, play: true });
      else if (typeof options.start === 'object') this.command('seek', { ...locate(current.doc, options.start), play: true });
      else this.command('play');
      return;
    }
    this.settings = this.services.settings();
    const reading = this.build(options.document, selection, new Map());
    clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    await this.save();
    this.highlight.clear();
    this.previews.clear();
    this.reading = reading;
    const at = this.startAt(reading, options.start);
    this.index = at.index;
    this.word = -1;
    this.playing = false;
    this.waiting = false;
    this.elapsed = 0;
    this.total = 0;
    this.start = { index: at.index, offset: 0, word: at.word, autoplay: true };
    this.events.length = 0;
    if (!this.acquired) {
      this.services.acquire();
      this.acquired = true;
    }
    this.view.description = reading.title;
    this.renew();
    this.sendPlan();
    this.showPosition();
    this.updateControls();
    this.changed.fire();
    // The shared engine stops after a while unused, so pick it again for every new document.
    void this.selectEngine().catch(error => this.fail(error));
    if (!this.view.ready) await this.view.reveal(true);
  }

  private build(document: vscode.TextDocument, selection: SourceRange | undefined, overrides: Map<number, string>): Reading {
    const doc = buildDocument(document.getText(selection ? toRange(selection) : undefined), {
      tableMode: this.settings.tableMode, codeBlocks: this.settings.codeBlocks,
      lineOffset: selection?.line ?? 0, characterOffset: selection?.character ?? 0, overrides
    });
    if (!doc.utterances.length) throw new Error(selection ? 'There is no readable text in the selection.' : 'There is no readable text in this Markdown.');
    return { document, uri: document.uri, title: path.posix.basename(document.uri.path), selection, doc, overrides, stale: false };
  }

  private startAt(reading: Reading, start: Start): { index: number; word: number } {
    const { utterances } = reading.doc;
    if (start === 'top') return { index: 0, word: -1 };
    if (start === 'resume') {
      const saved = reading.selection ? undefined : this.services.position(reading.uri);
      if (!saved) return { index: 0, word: -1 };
      const index = utterances[saved.index]?.line === saved.line ? saved.index : Math.max(0, utterances.findIndex(u => u.endLine > saved.line));
      return { index: index >= utterances.length - 1 ? 0 : index, word: -1 };
    }
    return locate(reading.doc, start);
  }

  /** Rebuilds the narration (after edits, a setting change or a Copilot description), keeping the listener's place. */
  private rebuild(withOverrides: boolean): void {
    const reading = this.reading;
    if (!reading) return;
    this.settings = this.services.settings();
    const utterance = reading.doc.utterances[this.index];
    const place = utterance?.words[Math.max(0, this.word)]?.range ?? utterance?.range;
    const block = utterance?.block;
    const next = this.build(reading.document, reading.selection, withOverrides ? reading.overrides : new Map());
    this.reading = next;
    const first = block === undefined ? -1 : next.doc.blocks[block]?.first ?? -1;
    const at = place ? locate(next.doc, { line: place.line, character: place.character }) : { index: Math.max(0, first), word: -1 };
    this.index = at.index;
    this.word = -1;
    this.start = { index: at.index, offset: 0, word: at.word, autoplay: this.playing };
    this.renew();
    this.sendPlan();
    this.showPosition();
    this.updateControls();
    this.changed.fire();
  }

  /** Keeps highlights on the right text while the document is edited, and offers to update the narration. */
  private edited(event: vscode.TextDocumentChangeEvent): void {
    const reading = this.reading;
    if (!reading || !event.contentChanges.length || event.document.uri.toString() !== reading.uri.toString()) return;
    const changes: TextChange[] = event.contentChanges.map(change => ({
      start: { line: change.range.start.line, character: change.range.start.character },
      end: { line: change.range.end.line, character: change.range.end.character },
      text: change.text
    }));
    applyChanges(reading.doc, changes);
    if (reading.selection) {
      let selection: SourceRange | null = reading.selection;
      for (const change of [...changes].sort((a, b) => b.start.line - a.start.line || b.start.character - a.start.character)) {
        selection = selection && shiftRange(selection, change);
      }
      reading.selection = selection ?? reading.selection;
    }
    if (!reading.stale) {
      reading.stale = true;
      this.view.post({ type: 'stale', value: true });
    }
    // Move the highlight with the text, but never scroll away from where the listener is typing.
    this.showPosition(false);
    this.changed.fire();
  }

  /** Sends a transport command to the player. */
  command(action: string, extra: Record<string, unknown> = {}): void {
    if (!this.reading) return;
    if (this.view.ready) {
      this.view.post({ type: 'command', action, ...extra });
      return;
    }
    // The player is (re)loading: carry the intent into the plan it receives when ready.
    if (action === 'seek') this.start = { index: Number(extra.index) || 0, offset: 0, word: Number(extra.word ?? -1), autoplay: !!extra.play };
    else if (action === 'play' || action === 'togglePlay') this.start.autoplay = true;
    void this.view.reveal(true);
  }

  async stop(): Promise<void> {
    if (!this.reading) return;
    this.view.post({ type: 'command', action: 'pause' });
    clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    await this.save();
    this.reading = undefined;
    this.scheduler?.dispose();
    this.scheduler = undefined;
    // The shared engine shuts down after a while unused; never keep (and so restart) a stopped one.
    this.engine = undefined;
    this.state = 'loading';
    this.stateMessage = '';
    this.revision++;
    this.playing = false;
    this.waiting = false;
    this.highlight.clear();
    this.previews.clear();
    this.view.post({ type: 'idle' });
    this.view.description = undefined;
    this.updateControls();
    this.changed.fire();
    if (this.acquired) {
      this.services.release();
      this.acquired = false;
    }
  }

  backToReading(): void {
    this.highlight.backToReading();
    if (this.reading) this.previews.reveal(this.reading.uri);
    this.showPosition();
  }

  /** Re-reads the document after it was edited, from the same place. */
  refresh(): void {
    if (this.reading?.selection) throw new Error('Select the text again and choose Read Selection Aloud to hear the changes.');
    this.rebuild(false);
  }

  private post(message: object): void {
    if (!this.disposed) this.view.post(message);
  }

  private fail(error: unknown): void {
    if (this.disposed) return;
    const message = error instanceof Error ? error.message : String(error);
    this.services.output.appendLine(message);
    this.post({ type: 'error', message });
  }

  private sendPlan(): void {
    const reading = this.reading;
    if (!reading) {
      this.post({ type: 'idle' });
      return;
    }
    const s = this.settings;
    this.post(planMessage(reading.doc, this.revision, this.start, {
      rate: this.rate, expandedSpeeds: s.expandedSpeeds, volume: s.volume, followInEditor: s.followInEditor, highlightWords: s.highlightWords, skipBack: s.skipBack,
      skipForward: s.skipForward, tableMode: s.tableMode, codeBlocks: s.codeBlocks
    }, reading.title, !!reading.selection));
    this.sendEngine();
    if (reading.stale) this.post({ type: 'stale', value: true });
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

  /** Starts a new audio generation: any change of voice, engine or narration invalidates audio already made. */
  private renew(): void {
    this.scheduler?.dispose();
    this.scheduler = undefined;
    this.revision++;
    const engine = this.engine;
    const reading = this.reading;
    if (!engine || !reading) return;
    const revision = this.revision;
    this.scheduler = new Scheduler({
      engine, utterances: reading.doc.utterances, voice: this.voice,
      dictionary: [...dictionaryFrom(this.settings.pronunciations)],
      deliver: (index, segment) => {
        if (revision !== this.revision) return;
        const info = parseWav(segment.wav);
        this.post({
          type: 'audio', revision, index, times: segment.wordTimes,
          pcm: segment.wav.slice(info.dataOffset, info.dataOffset + info.dataLength),
          format: { sampleRate: info.sampleRate, channels: info.channels, bits: info.bits, blockAlign: info.blockAlign }
        });
      },
      fail: (index, error) => {
        if (revision !== this.revision) return;
        this.services.output.appendLine(`Speech failed at passage ${index + 1}: ${error.message}`);
        this.post({ type: 'error', revision, index, message: `Speech failed: ${error.message}` });
      },
      log: message => this.services.output.appendLine(message)
    });
  }

  private async selectEngine(): Promise<void> {
    if (this.download) return;
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
    const voice = this.settings.naturalVoice;
    const engine = this.services.naturalEngine(this.settings.quality, this.services.threads(this.settings.threads));
    if (this.engine === engine && this.state === 'ready') {
      if (voice !== this.voice) {
        this.voice = voice;
        this.renew();
      }
      this.sendEngine();
      return;
    }
    this.voice = voice;
    this.engine = undefined;
    this.renew();
    this.setState('loading');
    try {
      await engine.start();
    } catch (error) {
      this.setState('error', `The natural voice could not start: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    if (this.disposed || !this.reading) return;
    this.engine = engine;
    this.renew();
    this.setState('ready');
  }

  private async useSystem(): Promise<void> {
    if (this.kind === 'system' && this.engine?.kind === 'system' && this.state === 'ready') {
      // Already running: only follow a changed voice setting.
      const voice = this.voices.some(v => v.id === this.settings.systemVoice) ? this.settings.systemVoice : '';
      if (voice !== this.voice) {
        this.voice = voice;
        this.renew();
      }
      this.sendEngine();
      return;
    }
    this.kind = 'system';
    this.engine = undefined;
    this.renew();
    this.setState('loading');
    try {
      const { engine, voices } = await this.services.systemEngine();
      if (this.disposed || !this.reading) return;
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
      this.download = undefined;
      await this.services.update('engine', 'natural');
      this.settings = this.services.settings();
      await this.useNatural();
    } catch (error) {
      this.setState('missing', error instanceof Error ? error.message : String(error));
    } finally {
      this.download = undefined;
    }
  }

  async changeVoice(voice: string): Promise<void> {
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

  /** Voices the current engine offers, for the voice picker. */
  voiceChoices(): { voices: { id: string; label: string }[]; voice: string; kind: 'natural' | 'system' } {
    return { voices: this.voices, voice: this.voice, kind: this.kind };
  }

  private async handle(message: PlayerMessage): Promise<void> {
    switch (message.type) {
      case 'ready':
        this.sendPlan();
        if (!this.reading) this.postSettings();
        break;
      case 'need':
        if (message.revision === this.revision && Array.isArray(message.indices)) {
          this.scheduler?.need((message.indices as number[]).slice(0, 60), Number(message.ahead) || 0, Number(message.rate) || 1);
        }
        break;
      case 'position':
        this.position(message);
        break;
      case 'event':
        if (typeof message.event !== 'string') break;
        if (this.events.length < 5000) this.events.push(message.event);
        // Sound needs a click or key press in the player first: make sure the listener can see it.
        if (message.event === 'needs-gesture') await this.view.reveal(true);
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
      case 'readActive':
        await vscode.commands.executeCommand('clearMarkdown.read');
        break;
      case 'refresh':
        this.refresh();
        break;
    }
  }

  private position(message: PlayerMessage): void {
    const reading = this.reading;
    if (!reading || message.revision !== this.revision) return;
    const index = clamp(Math.round(Number(message.index) || 0), 0, reading.doc.utterances.length - 1);
    const word = Number.isInteger(message.word) ? Number(message.word) : -1;
    const moved = index !== this.index || word !== this.word;
    this.index = index;
    this.word = word;
    this.playing = !!message.playing;
    this.waiting = !!message.waiting;
    this.elapsed = Number(message.elapsed) || 0;
    this.total = Number(message.total) || 0;
    if (isSpeed(message.rate)) this.rate = message.rate;
    if (typeof message.volume === 'number') this.volume = message.volume;
    this.muted = !!message.muted;
    this.start = { index, offset: Number(message.offset) || 0, word: -1, autoplay: this.playing };
    if (moved) this.showPosition();
    this.updateControls();
    this.scheduleSave();
  }

  private showPosition(scroll = true): void {
    const reading = this.reading;
    if (!reading) return;
    const utterance = reading.doc.utterances[this.index];
    const word = this.word >= 0 ? utterance?.words[this.word]?.range ?? null : null;
    this.highlight.show(reading.uri, utterance?.range ?? null, word, scroll);
    this.previews.show({ uri: reading.uri.toString(), sentence: utterance?.range ?? null, word });
  }

  private updateControls(): void {
    const s = this.settings;
    this.controls.update({
      uri: this.reading?.uri, title: this.reading?.title, playing: this.playing, waiting: this.waiting, elapsed: this.elapsed, total: this.total,
      rate: this.rate, skipBack: s.skipBack, skipForward: s.skipForward, detached: this.highlight.isDetached
    });
  }

  private async setting(key: string, value: unknown): Promise<void> {
    switch (key) {
      case 'rate':
        if (isSpeed(value)) {
          this.rate = value;
          this.updateControls();
          await this.services.update('rate', value);
        }
        break;
      case 'volume':
        if (typeof value === 'number' && value >= 0 && value <= 100) await this.services.update('volume', Math.round(value));
        break;
      case 'expandedSpeeds':
        if (typeof value === 'boolean') await this.services.update('expandedSpeeds', value);
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

  /** Sets the speed from a command; the player applies it at once and saves it. */
  setRate(value: number): void {
    if (!isSpeed(value)) return;
    this.rate = value;
    this.updateControls();
    if (this.reading && this.view.ready) this.post({ type: 'command', action: 'setRate', value });
    else void this.services.update('rate', value);
  }

  get speed(): number {
    return this.rate;
  }

  /** Applies settings changed outside the player (Settings editor, settings.json or another window). */
  private async configurationChanged(event: vscode.ConfigurationChangeEvent): Promise<void> {
    const before = this.settings;
    const after = this.services.settings();
    const changed = (key: string) => event.affectsConfiguration(`clearMarkdown.${key}`);
    this.settings = after;
    const playerSettings = ['rate', 'expandedSpeeds', 'volume', 'highlightWords', 'followInEditor', 'skipBackSeconds', 'skipForwardSeconds'].some(changed);
    if (!this.reading) {
      this.kind = after.engine;
      this.rate = after.rate;
      this.highlight.configure({ follow: after.followInEditor, words: after.highlightWords });
      this.previews.configure({ follow: after.followInEditor, words: after.highlightWords });
      if (playerSettings) this.postSettings();
      return;
    }
    if (changed('engine') || changed('naturalQuality') || changed('threads')) {
      if (after.engine !== this.kind || after.quality !== before.quality || after.threads !== before.threads) await this.selectEngine();
    } else if ((changed('naturalVoice') || changed('systemVoice')) && this.state === 'ready') {
      const voice = this.kind === 'natural' ? after.naturalVoice : after.systemVoice;
      if (voice !== this.voice) await this.changeVoice(voice);
    }
    if (changed('tableMode') || changed('codeBlocks')) {
      if (after.tableMode !== before.tableMode || after.codeBlocks !== before.codeBlocks) this.rebuild(true);
    } else if (changed('pronunciations')) {
      this.renew();
      this.sendEngine();
    }
    if (playerSettings) {
      if (changed('rate')) this.rate = after.rate;
      this.highlight.configure({ follow: after.followInEditor, words: after.highlightWords });
      this.previews.configure({ follow: after.followInEditor, words: after.highlightWords });
      this.postSettings();
      this.showPosition();
      this.updateControls();
    }
  }

  private postSettings(): void {
    const s = this.settings;
    this.post({
      type: 'settings', rate: this.rate, expandedSpeeds: s.expandedSpeeds, volume: s.volume, highlightWords: s.highlightWords, followInEditor: s.followInEditor,
      skipBack: s.skipBack, skipForward: s.skipForward, tableMode: s.tableMode, codeBlocks: s.codeBlocks
    });
  }

  /** Tables and code blocks in the document being read, for the Copilot CodeLens. */
  describable(uri: vscode.Uri): { block: number; kind: 'table' | 'code'; line: number; described: boolean }[] {
    const reading = this.reading;
    if (!reading || reading.uri.toString() !== uri.toString() || reading.stale) return [];
    return reading.doc.blocks.flatMap((block, index) => block.kind === 'table' || block.kind === 'code'
      ? [{ block: index, kind: block.kind, line: block.line, described: reading.overrides.has(index) }]
      : []);
  }

  /** The table or code block at a position in the document being read. */
  blockAt(uri: vscode.Uri, line: number): number | undefined {
    return this.describable(uri).find(block => {
      const info = this.reading!.doc.blocks[block.block]!;
      return line >= info.line && line < info.endLine;
    })?.block;
  }

  /** Asks Copilot to describe a table or code block, and reads the description if the listener approves it. */
  async describe(uri: vscode.Uri, block: number): Promise<void> {
    const reading = this.reading;
    const info = reading?.doc.blocks[block];
    if (!reading || !this.isReading(uri) || !info || (info.kind !== 'table' && info.kind !== 'code')) return;
    const document = reading.document;
    const text = document.getText(new vscode.Range(info.line, 0, Math.min(info.endLine, document.lineCount), 0));
    const description = await describeBlock(this.services.context, info.kind, text);
    if (!description || this.reading !== reading) return;
    const answer = await vscode.window.showInformationMessage(
      `Read Copilot's description instead of the ${info.kind === 'table' ? 'table' : 'code'}?`,
      { modal: true, detail: `${description}\n\nCheck it against the original before using it; AI can make mistakes.` },
      'Read Description'
    );
    if (answer !== 'Read Description' || this.reading !== reading) return;
    reading.overrides.set(block, description);
    this.rebuild(true);
  }

  restore(uri: vscode.Uri, block: number): void {
    if (!this.reading || !this.isReading(uri) || !this.reading.overrides.delete(block)) return;
    this.rebuild(true);
  }

  /** Saves the position every few seconds while reading, so closing VS Code mid-sentence keeps the place. */
  private scheduleSave(): void {
    if (this.reading?.selection || this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      void this.save();
    }, 3000);
  }

  private async save(): Promise<void> {
    const reading = this.reading;
    if (!reading || reading.selection) return;
    const utterance = reading.doc.utterances[this.index];
    const finished = this.index >= reading.doc.utterances.length - 1 && !this.playing;
    await this.services.savePosition(reading.uri, utterance && !finished
      ? { line: utterance.line, index: this.index, total: reading.doc.utterances.length, at: Date.now() }
      : undefined);
  }

  /** State for the integration test and diagnostics. */
  snapshot() {
    return {
      loaded: !!this.reading, file: this.reading?.title, events: [...this.events], playing: this.playing, waiting: this.waiting,
      index: this.index, word: this.word, total: this.reading?.doc.utterances.length ?? 0, state: this.state, kind: this.kind, rate: this.rate,
      viewVisible: this.view.visible, detached: this.highlight.isDetached, stale: !!this.reading?.stale, volume: this.volume, muted: this.muted,
      ...this.highlight.highlighted(), ...this.previews.snapshot(this.reading?.uri),
      expectedWord: this.word >= 0 ? this.reading?.doc.utterances[this.index]?.words[this.word]?.text : undefined
    };
  }

  dispose(): void {
    if (this.disposed) return;
    clearTimeout(this.saveTimer);
    void this.save();
    this.disposed = true;
    this.download?.abort();
    this.scheduler?.dispose();
    this.disposables.forEach(disposable => disposable.dispose());
    if (this.acquired) this.services.release();
  }
}
