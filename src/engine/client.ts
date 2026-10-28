import { fork, type ChildProcess } from 'node:child_process';
import type { SynthesisRequest } from './kokoro';

export interface AudioSegment {
  wav: Uint8Array;
  duration: number;
  /** Start and end seconds per word; -1 when unknown. */
  wordTimes: number[];
}

export interface SpeechInput { words: { text: string; sep: string }[]; pause: number }

export interface SpeechEngine {
  readonly kind: 'natural' | 'system';
  /** Spoken characters to combine into one request after the first, latency-sensitive request. */
  readonly batchChars: number;
  synthesize(utterances: SpeechInput[], voice: string, dictionary: [string, string][], signal: AbortSignal): Promise<AudioSegment[]>;
  dispose(): void;
}

interface Pending { resolve: (value: Reply) => void; reject: (error: Error) => void }
interface Reply { id: number; type: 'ok' | 'error'; message?: string; segments?: AudioSegment[] }

/** Runs Kokoro in a separate Node process so inference never blocks or crashes the extension host. */
export class NaturalEngine implements SpeechEngine {
  readonly kind = 'natural';
  readonly batchChars = 170;
  private child: ChildProcess | undefined;
  private loading: Promise<void> | undefined;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private stderr = '';

  constructor(
    private readonly script: string,
    private readonly modelPath: string,
    private readonly voicesDir: string,
    private readonly threads: number,
    private readonly log: (message: string) => void
  ) {}

  private send(message: object): Promise<Reply> {
    const child = this.child;
    if (!child?.connected) return Promise.reject(new Error('The natural voice engine is not running.'));
    const id = this.nextId++;
    return new Promise<Reply>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      child.send({ ...message, id }, error => {
        if (error) {
          this.pending.delete(id);
          reject(error);
        }
      });
    }).then(reply => {
      if (reply.type === 'error') throw new Error(reply.message ?? 'The natural voice engine failed.');
      return reply;
    });
  }

  start(): Promise<void> {
    if (this.loading) return this.loading;
    const child = fork(this.script, [], {
      execArgv: [],
      serialization: 'advanced',
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      windowsHide: true,
      // VS Code runs extensions in Electron; this makes the child behave as plain Node.js.
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
    });
    this.child = child;
    this.stderr = '';
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (data: string) => {
      this.stderr = (this.stderr + data).slice(-4000);
    });
    child.on('message', (reply: Reply) => {
      const pending = this.pending.get(reply.id);
      if (!pending) return;
      this.pending.delete(reply.id);
      pending.resolve(reply);
    });
    child.on('exit', (code, signal) => {
      if (this.child !== child) return;
      const detail = this.stderr.trim().split('\n').slice(-3).join(' ');
      const error = new Error(`The natural voice engine stopped (${signal ?? `exit code ${code}`}).${detail ? ` ${detail}` : ''}`);
      if (this.pending.size) this.log(error.message);
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
      this.child = undefined;
      this.loading = undefined;
    });
    this.loading = this.send({ type: 'load', modelPath: this.modelPath, voicesDir: this.voicesDir, threads: this.threads })
      .then(() => undefined, error => {
        this.dispose();
        throw error;
      });
    return this.loading;
  }

  async synthesize(utterances: SpeechInput[], voice: string, dictionary: [string, string][], signal: AbortSignal): Promise<AudioSegment[]> {
    await this.start();
    if (signal.aborted) throw new Error('cancelled');
    const request: SynthesisRequest = { utterances, voice, dictionary };
    const reply = await this.send({ type: 'synthesize', request });
    return reply.segments!;
  }

  get running(): boolean {
    return !!this.child;
  }

  dispose(): void {
    const child = this.child;
    this.child = undefined;
    this.loading = undefined;
    for (const pending of this.pending.values()) pending.reject(new Error('cancelled'));
    this.pending.clear();
    if (!child) return;
    if (child.connected) child.send({ id: 0, type: 'shutdown' }, () => undefined);
    setTimeout(() => { if (child.exitCode === null) child.kill(); }, 2000).unref();
  }
}
