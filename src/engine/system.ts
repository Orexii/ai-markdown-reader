import { randomUUID } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import * as path from 'node:path';
import type { NativeSpeech } from '../speech';
import { pronounceAsText } from './pronounce';
import { appendSilence } from './wav';
import type { AudioSegment, SpeechEngine, SpeechInput } from './client';

/** Operating-system voices, used when the natural voice is not installed. Word timing is estimated. */
export class SystemEngine implements SpeechEngine {
  readonly kind = 'system';
  readonly batchChars = 0;

  constructor(private readonly speech: NativeSpeech, private readonly directory: string) {}

  async synthesize(utterances: SpeechInput[], voice: string, dictionary: [string, string][], signal: AbortSignal): Promise<AudioSegment[]> {
    const words = new Map(dictionary);
    const results: AudioSegment[] = [];
    for (const utterance of utterances) {
      const spoken = utterance.words.map((word, k) => pronounceAsText(word.text, words, utterance.words[k - 1]?.text));
      const text = spoken.map((value, k) => value + utterance.words[k]!.sep).join('').trim();
      const file = path.join(this.directory, `${randomUUID()}.wav`);
      try {
        await this.speech.synthesize(text, voice, file, signal);
        const { wav, speechDuration, duration } = appendSilence(new Uint8Array(await readFile(file)), utterance.pause);
        const weights = spoken.map((value, k) => Math.max(1, value.length + utterance.words[k]!.sep.trim().length * 3));
        const total = weights.reduce((a, b) => a + b, 0);
        let before = 0;
        const wordTimes = weights.flatMap(weight => {
          const start = (speechDuration * before) / total;
          before += weight;
          return [start, (speechDuration * before) / total];
        });
        results.push({ wav, duration, wordTimes });
      } finally {
        await rm(file, { force: true });
      }
    }
    return results;
  }

  dispose(): void {}
}
