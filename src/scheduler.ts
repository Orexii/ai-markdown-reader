import type { AudioSegment, SpeechEngine, SpeechInput } from './engine/client';
import type { Utterance } from './document';

export interface SchedulerOptions {
  engine: SpeechEngine;
  utterances: Utterance[];
  voice: string;
  dictionary: [string, string][];
  deliver(index: number, segment: AudioSegment): void;
  fail(index: number, error: Error): void;
  /** Maximum cached audio bytes before old passages are dropped. */
  cacheBytes?: number;
}

const URGENT_CHARS = 90;
/** Kokoro is weaker on very short inputs, so tiny passages are always combined with what follows. */
const SHORT_CHARS = 40;
const MAX_CHARS = 250;

export function spokenLength(utterance: Utterance): number {
  return utterance.words.reduce((sum, word) => sum + word.text.length + word.sep.length, 0);
}

/** Synthesizes the passages the player needs, most urgent first, combining neighbours for natural prosody. */
export class Scheduler {
  private wanted: number[] = [];
  private readonly cache = new Map<number, AudioSegment>();
  private cachedBytes = 0;
  private readonly inflight = new Set<number>();
  private running = false;
  private urgent = true;
  private readonly controller = new AbortController();

  constructor(private readonly options: SchedulerOptions) {}

  /** Replaces the wanted list. The first index is needed now; the rest are prefetched in order. */
  need(indices: number[]): void {
    const count = this.options.utterances.length;
    const valid = [...new Set(indices.filter(i => Number.isInteger(i) && i >= 0 && i < count))];
    for (const index of valid) {
      const cached = this.cache.get(index);
      if (cached) {
        this.cache.delete(index);
        this.cache.set(index, cached);
        this.options.deliver(index, cached);
      }
    }
    this.wanted = valid.filter(index => !this.cache.has(index));
    const first = valid[0];
    this.urgent = first !== undefined && !this.cache.has(first) && !this.inflight.has(first);
    void this.pump();
  }

  private input(index: number): SpeechInput {
    const utterance = this.options.utterances[index]!;
    return { words: utterance.words.map(word => ({ text: word.text, sep: word.sep })), pause: utterance.pauseAfter };
  }

  private batch(start: number): number[] {
    const { engine, utterances } = this.options;
    const batch = [start];
    if (!engine.batchChars) return batch;
    const limit = this.urgent ? Math.min(URGENT_CHARS, engine.batchChars) : engine.batchChars;
    let chars = spokenLength(utterances[start]!);
    for (let next = start + 1; next < utterances.length; next++) {
      if (this.cache.has(next) || this.inflight.has(next)) break;
      const size = spokenLength(utterances[next]!);
      if (chars + size > MAX_CHARS) break;
      if (chars >= SHORT_CHARS && (chars + size > limit || !this.wanted.includes(next))) break;
      batch.push(next);
      chars += size;
    }
    return batch;
  }

  private store(index: number, segment: AudioSegment): void {
    this.cache.set(index, segment);
    this.cachedBytes += segment.wav.byteLength;
    const limit = this.options.cacheBytes ?? 120 * 1024 * 1024;
    for (const [key, value] of this.cache) {
      if (this.cachedBytes <= limit) break;
      if (this.wanted.includes(key)) continue;
      this.cache.delete(key);
      this.cachedBytes -= value.wav.byteLength;
    }
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (!this.controller.signal.aborted) {
        const start = this.wanted.find(index => !this.cache.has(index) && !this.inflight.has(index));
        if (start === undefined) break;
        const batch = this.batch(start);
        this.urgent = false;
        batch.forEach(index => this.inflight.add(index));
        try {
          const segments = await this.options.engine.synthesize(batch.map(index => this.input(index)), this.options.voice,
            this.options.dictionary, this.controller.signal);
          if (this.controller.signal.aborted) return;
          if (segments.length !== batch.length) throw new Error('The speech engine returned an unexpected number of passages.');
          segments.forEach((segment, k) => {
            this.store(batch[k]!, segment);
            this.options.deliver(batch[k]!, segment);
          });
        } catch (error) {
          if (this.controller.signal.aborted) return;
          this.options.fail(batch[0]!, error instanceof Error ? error : new Error(String(error)));
        } finally {
          batch.forEach(index => this.inflight.delete(index));
          this.wanted = this.wanted.filter(index => !batch.includes(index));
        }
      }
    } finally {
      this.running = false;
    }
  }

  dispose(): void {
    this.controller.abort();
    this.cache.clear();
    this.wanted = [];
  }
}
