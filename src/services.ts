import * as vscode from 'vscode';
import * as os from 'node:os';
import * as path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { NaturalEngine } from './engine/client';
import { SystemEngine } from './engine/system';
import { NativeSpeech, type Voice } from './speech';
import { ModelStore, DEFAULT_VOICE, voiceInfo, type Quality } from './model';
import { SPEEDS } from './markup';

export interface Settings {
  engine: 'natural' | 'system';
  quality: Quality;
  naturalVoice: string;
  systemVoice: string;
  rate: number;
  /** Player volume in percent. */
  volume: number;
  tableMode: 'rows' | 'columns';
  codeBlocks: 'announce' | 'read' | 'skip';
  followInEditor: boolean;
  highlightWords: boolean;
  /** Swap VS Code's Markdown preview for the Read Aloud Preview when reading starts from it. */
  replaceMarkdownPreview: boolean;
  skipBack: number;
  skipForward: number;
  threads: number;
  pronunciations: Record<string, string>;
}

export interface Position { line: number; index: number; total: number; at: number }

const IDLE_SHUTDOWN_MS = 3 * 60 * 1000;

/** The offered speed closest to a configured value (older versions allowed any value up to 3). */
export function nearestSpeed(value: number): number {
  const wanted = Number.isFinite(value) ? value : 1;
  return SPEEDS.reduce<number>((best, speed) => (Math.abs(speed - wanted) < Math.abs(best - wanted) ? speed : best), 1);
}

/** Shared, long-lived state: settings, the model store, speech engines and saved positions. */
export class Services implements vscode.Disposable {
  readonly output = vscode.window.createOutputChannel('Clear Markdown Reader');
  readonly store: ModelStore;
  private natural: { engine: NaturalEngine; key: string } | undefined;
  private system: Promise<{ engine: SystemEngine; voices: Voice[]; directory: string }> | undefined;
  private idle: NodeJS.Timeout | undefined;
  private users = 0;

  constructor(readonly context: vscode.ExtensionContext) {
    this.store = new ModelStore(path.join(context.globalStorageUri.fsPath, 'kokoro-82m-v1.0'));
  }

  settings(): Settings {
    const config = vscode.workspace.getConfiguration('clearMarkdown');
    const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));
    const naturalVoice = config.get<string>('naturalVoice', DEFAULT_VOICE);
    return {
      engine: config.get<'natural' | 'system'>('engine', 'natural') === 'system' ? 'system' : 'natural',
      quality: config.get<Quality>('naturalQuality', 'best') === 'compact' ? 'compact' : 'best',
      naturalVoice: voiceInfo(naturalVoice) ? naturalVoice : DEFAULT_VOICE,
      // "voice" is the 0.1 setting name for system voices.
      systemVoice: config.get<string>('systemVoice', '') || config.get<string>('voice', ''),
      rate: nearestSpeed(config.get<number>('rate', 1)),
      volume: Math.round(clamp(config.get<number>('volume', 100), 0, 100)),
      tableMode: config.get('tableMode') === 'columns' ? 'columns' : 'rows',
      codeBlocks: (['announce', 'read', 'skip'] as const).find(mode => mode === config.get('codeBlocks')) ?? 'announce',
      followInEditor: config.get<boolean>('followInEditor', true),
      highlightWords: config.get<boolean>('highlightWords', true),
      replaceMarkdownPreview: config.get<boolean>('replaceMarkdownPreview', true),
      skipBack: clamp(config.get<number>('skipBackSeconds', 10), 1, 120),
      skipForward: clamp(config.get<number>('skipForwardSeconds', 30), 1, 300),
      threads: Math.round(clamp(config.get<number>('threads', 0), 0, 32)),
      pronunciations: config.get<Record<string, string>>('pronunciations', {})
    };
  }

  async update(key: string, value: unknown): Promise<void> {
    await vscode.workspace.getConfiguration('clearMarkdown').update(key, value, vscode.ConfigurationTarget.Global);
  }

  threads(setting: number): number {
    return setting || Math.max(1, Math.min(8, Math.floor((os.availableParallelism?.() ?? os.cpus().length) / 2)));
  }

  /** Returns the shared natural engine, restarting it if the model or thread count changed. */
  naturalEngine(quality: Quality, threads: number): NaturalEngine {
    const key = `${quality}:${threads}`;
    if (this.natural?.key !== key) {
      this.natural?.engine.dispose();
      const engine = new NaturalEngine(this.context.asAbsolutePath('dist/engine.js'), this.store.modelPath(quality),
        this.store.voicesDir, this.context.asAbsolutePath('lexicon'), threads, message => this.output.appendLine(message));
      this.natural = { engine, key };
    }
    return this.natural.engine;
  }

  systemEngine(): Promise<{ engine: SystemEngine; voices: Voice[] }> {
    this.system ??= (async () => {
      const speech = await NativeSpeech.create(this.context.asAbsolutePath('scripts/speak.ps1'));
      const voices = await speech.voices();
      const directory = await mkdtemp(path.join(os.tmpdir(), 'clear-markdown-'));
      return { engine: new SystemEngine(speech, directory), voices, directory };
    })();
    this.system.catch(() => { this.system = undefined; });
    return this.system;
  }

  stopNatural(): void {
    this.natural?.engine.dispose();
    this.natural = undefined;
  }

  /** The reader calls acquire/release so the natural engine stops when nothing has used it for a while. */
  acquire(): void {
    this.users++;
    clearTimeout(this.idle);
  }

  release(): void {
    this.users = Math.max(0, this.users - 1);
    if (this.users) return;
    clearTimeout(this.idle);
    this.idle = setTimeout(() => {
      this.natural?.engine.dispose();
      this.natural = undefined;
    }, IDLE_SHUTDOWN_MS);
  }

  position(uri: vscode.Uri): Position | undefined {
    return this.context.globalState.get<Record<string, Position>>('clearMarkdown.positions', {})[uri.toString()];
  }

  async savePosition(uri: vscode.Uri, position: Position | undefined): Promise<void> {
    const positions = { ...this.context.globalState.get<Record<string, Position>>('clearMarkdown.positions', {}) };
    if (position) positions[uri.toString()] = position;
    else delete positions[uri.toString()];
    const recent = Object.entries(positions).sort((a, b) => b[1].at - a[1].at).slice(0, 200);
    await this.context.globalState.update('clearMarkdown.positions', Object.fromEntries(recent));
  }

  dispose(): void {
    clearTimeout(this.idle);
    this.natural?.engine.dispose();
    void this.system?.then(system => rm(system.directory, { recursive: true, force: true })).catch(() => undefined);
    this.output.dispose();
  }
}
