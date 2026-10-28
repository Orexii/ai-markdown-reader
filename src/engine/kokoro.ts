import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { VOCAB } from './vocab';
import { pronounce, type Accent } from './pronounce';
import { Lexicon, startsWithVowel, type LexiconData } from './lexicon';

export const SAMPLE_RATE = 24000;
const SAMPLES_PER_FRAME = 600;
const STYLE_SIZE = 256;
const MAX_TOKENS = 512;
const LEAD = 0.03;
const TAIL = 0.08;
const SPACE = VOCAB[' ']!;

export interface SynthesisWord { text: string; sep: string }
export interface SynthesisUtterance { words: SynthesisWord[]; pause: number }
export interface SynthesisRequest {
  utterances: SynthesisUtterance[];
  voice: string;
  speed?: number;
  dictionary?: [string, string][];
}
export interface SynthesizedSegment {
  samples: Float32Array;
  /** Start and end seconds for each word, relative to the segment; -1 when a word produced no sound. */
  wordTimes: number[];
  duration: number;
}

type Phonemize = (text: string, language: string) => Promise<string[]>;
interface TensorLike { data: unknown }
interface OrtLike {
  Tensor: new (type: 'int64' | 'float32', data: BigInt64Array | Float32Array, dims: number[]) => unknown;
  InferenceSession: { create(path: string, options: object): Promise<SessionLike> };
}
interface SessionLike { run(feeds: Record<string, unknown>): Promise<Record<string, TensorLike>> }

export class TooLongError extends Error {}

/**
 * Rewrites eSpeak NG IPA in the phoneme set Kokoro was trained on (misaki): single-symbol diphthongs
 * and affricates, no length marks in American English, and so on. Follows misaki's EspeakFallback
 * E2M table; eSpeak here has no tie marks, so only unambiguous sequences are merged.
 */
export function toMisaki(phonemes: string, accent: Accent): string {
  let out = phonemes
    .replace(/ʔˌn̩|ʔn̩/g, 'ʔn')
    .replace(/aɪ/g, 'I').replace(/aʊ/g, 'W').replace(/eɪ/g, 'A').replace(/ɔɪ/g, 'Y')
    .replace(/dʒ/g, 'ʤ').replace(/tʃ/g, 'ʧ')
    .replace(/ʲo/g, 'jo').replace(/ʲə/g, 'jə').replace(/ʲ/g, '')
    .replace(/ɚɹ/g, 'əɹ').replace(/ɚ/g, 'əɹ').replace(/r/g, 'ɹ').replace(/[xç]/g, 'k').replace(/ɐ/g, 'ə').replace(/ɬ/g, 'l')
    .replace(/\u0303/g, '')
    // Syllabic l at the end of a word, as in "table" or "tables".
    .replace(/əl(?=[sz]?(?:\s|$|[;:,.!?—…"“”()]))/g, 'ᵊl');
  if (accent === 'gb') {
    out = out.replace(/eə/g, 'ɛː').replace(/iə/g, 'ɪə').replace(/əʊ/g, 'Q');
  } else {
    out = out.replace(/oʊ/g, 'O').replace(/ɜːɹ/g, 'ɜɹ').replace(/ɜː/g, 'ɜɹ').replace(/ɪə/g, 'iə').replace(/ː/g, '');
  }
  return out.replace(/e/g, 'A').replace(/o/g, 'ɔ').replace(/ʔ/g, 't');
}

function postprocess(phonemes: string, accent: Accent): string {
  // Fixes used by the official kokoro.js frontend for eSpeak NG output, then misaki's symbols.
  let out = phonemes
    .replace(/kəkˈoːɹoʊ/g, 'kˈoʊkəɹoʊ')
    .replace(/kəkˈɔːɹəʊ/g, 'kˈəʊkəɹəʊ')
    .replace(/(?<=[a-zɹː])(?=hˈʌndɹɪd)/g, ' ')
    .replace(/ z(?=[;:,.!?¡¿—…"«»“” ]|$)/g, 'z');
  if (accent === 'us') out = out.replace(/(?<=nˈaɪn)ti(?!ː)/g, 'di');
  return toMisaki(out, accent).replace(/\s+/g, ' ').trim();
}

const PUNCTUATION = /[;:,.!?—…"“”()]/g;

interface Piece { word: number; text?: string; phonemes?: string; punct?: string }

export class KokoroModel {
  private readonly voices = new Map<string, Float32Array>();
  private readonly cache = new Map<string, string>();
  private readonly lexicons = new Map<Accent, Promise<Lexicon | undefined>>();

  private constructor(
    private readonly ort: OrtLike,
    private readonly session: SessionLike,
    private readonly voicesDir: string,
    private readonly phonemizer: Phonemize,
    private readonly lexiconDir: string | undefined
  ) {}

  static async load(options: { ort: OrtLike; modelPath: string; voicesDir: string; threads: number; phonemize: Phonemize; lexiconDir?: string }): Promise<KokoroModel> {
    const session = await options.ort.InferenceSession.create(options.modelPath, {
      intraOpNumThreads: options.threads, interOpNumThreads: 1, graphOptimizationLevel: 'all', executionMode: 'sequential'
    });
    return new KokoroModel(options.ort, session, options.voicesDir, options.phonemize, options.lexiconDir);
  }

  /** misaki's curated pronunciations, the phonemes Kokoro was trained on; eSpeak covers unknown words. */
  private lexicon(accent: Accent): Promise<Lexicon | undefined> {
    let lexicon = this.lexicons.get(accent);
    if (!lexicon) {
      lexicon = this.lexiconDir
        ? readFile(path.join(this.lexiconDir, `${accent}.json`), 'utf8').then(text => new Lexicon(JSON.parse(text) as LexiconData, accent === 'gb'))
        : Promise.resolve(undefined);
      this.lexicons.set(accent, lexicon);
    }
    return lexicon;
  }

  private async voice(name: string): Promise<Float32Array> {
    if (!/^[ab][fm]_[a-z]+$/.test(name)) throw new Error(`Unknown voice: ${name}`);
    let data = this.voices.get(name);
    if (!data) {
      const bytes = await readFile(path.join(this.voicesDir, `${name}.bin`));
      if (bytes.length !== 510 * STYLE_SIZE * 4) throw new Error(`Voice file for ${name} is damaged. Reinstall the natural voice.`);
      data = new Float32Array(new Uint8Array(bytes).buffer);
      this.voices.set(name, data);
    }
    return data;
  }

  private async espeak(text: string, accent: Accent): Promise<string> {
    const key = `${accent}:${text}`;
    let value = this.cache.get(key);
    if (value === undefined) {
      value = postprocess((await this.phonemizer(text, accent === 'gb' ? 'en' : 'en-us')).join(' '), accent);
      if (this.cache.size > 20000) this.cache.clear();
      this.cache.set(key, value);
    }
    return value;
  }

  /** Synthesizes consecutive utterances in one pass for natural prosody, then splits them at word boundaries. */
  async synthesize(request: SynthesisRequest): Promise<SynthesizedSegment[]> {
    try {
      return await this.synthesizeOnce(request);
    } catch (error) {
      if (!(error instanceof TooLongError)) throw error;
      const { utterances } = request;
      if (utterances.length > 1) {
        const middle = Math.ceil(utterances.length / 2);
        return [
          ...await this.synthesize({ ...request, utterances: utterances.slice(0, middle) }),
          ...await this.synthesize({ ...request, utterances: utterances.slice(middle) })
        ];
      }
      const words = utterances[0]!.words;
      if (words.length < 2) throw error;
      const middle = Math.ceil(words.length / 2);
      const [first] = await this.synthesize({ ...request, utterances: [{ words: words.slice(0, middle), pause: 0.12 }] });
      const [second] = await this.synthesize({ ...request, utterances: [{ words: words.slice(middle), pause: utterances[0]!.pause }] });
      const samples = new Float32Array(first!.samples.length + second!.samples.length);
      samples.set(first!.samples);
      samples.set(second!.samples, first!.samples.length);
      const offset = first!.duration;
      return [{
        samples,
        wordTimes: [...first!.wordTimes, ...second!.wordTimes.map(t => t < 0 ? t : t + offset)],
        duration: samples.length / SAMPLE_RATE
      }];
    }
  }

  private async synthesizeOnce(request: SynthesisRequest): Promise<SynthesizedSegment[]> {
    const accent: Accent = request.voice.startsWith('b') ? 'gb' : 'us';
    const dictionary = new Map(request.dictionary ?? []);
    const lexicon = await this.lexicon(accent);
    const ids: number[] = [0];
    const spans: ([number, number] | null)[][] = [];
    const push = (text: string) => {
      for (const ch of text) {
        const id = VOCAB[ch];
        if (id !== undefined) ids.push(id);
      }
    };
    const space = () => {
      if (ids.length > 1 && ids.at(-1) !== SPACE) ids.push(SPACE);
    };

    for (const [u, utterance] of request.utterances.entries()) {
      const pieces: Piece[] = [];
      for (const [k, word] of utterance.words.entries()) {
        for (const segment of pronounce(word.text, accent, dictionary)) {
          if ('phonemes' in segment) {
            pieces.push({ word: k, phonemes: toMisaki(segment.phonemes, accent) });
            continue;
          }
          for (const token of segment.text.split(/[\s/]+|(?<=\p{L})-(?=\p{L})/u)) {
            const text = token.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}']+$/gu, '');
            if (text) pieces.push({ word: k, text });
          }
        }
        const marks = (word.sep.match(PUNCTUATION) ?? []).join('');
        const last = k === utterance.words.length - 1;
        // Keep a phrase boundary between utterances even when a long sentence was cut without punctuation.
        if (marks || last) pieces.push({ word: -1, punct: marks || (u < request.utterances.length - 1 ? ',' : '.') });
      }
      // Resolve right to left, as misaki does, so "the", "a", "to" and "in" can depend on the next sound.
      let nextVowel: boolean | null = null;
      let nextIsTo = false;
      for (let i = pieces.length - 1; i >= 0; i--) {
        const piece = pieces[i]!;
        if (piece.punct !== undefined) {
          if (/[;:,.!?—…]/.test(piece.punct)) nextVowel = null;
          nextIsTo = false;
          continue;
        }
        if (piece.text !== undefined) {
          piece.phonemes = lexicon?.word(piece.text, { nextVowel, nextIsTo }) ?? await this.espeak(piece.text, accent);
        }
        const vowel = startsWithVowel(piece.phonemes);
        if (vowel !== undefined) nextVowel = vowel;
        nextIsTo = /^to$/i.test(piece.text ?? '');
      }
      const wordSpans: ([number, number] | null)[] = utterance.words.map(() => null);
      for (const piece of pieces) {
        if (piece.punct !== undefined) {
          push(piece.punct);
          continue;
        }
        if (!piece.phonemes) continue;
        space();
        const start = ids.length;
        push(piece.phonemes);
        if (ids.length === start) continue;
        const existing = wordSpans[piece.word];
        wordSpans[piece.word] = existing ? [existing[0], ids.length] : [start, ids.length];
      }
      spans.push(wordSpans);
    }
    while (ids.at(-1) === SPACE) ids.pop();
    ids.push(0);
    if (ids.length > MAX_TOKENS) throw new TooLongError(`Request has ${ids.length} phoneme tokens; the limit is ${MAX_TOKENS}.`);

    const style = await this.voice(request.voice);
    const count = Math.min(Math.max(ids.length - 2, 0), 509);
    const output = await this.session.run({
      input_ids: new this.ort.Tensor('int64', BigInt64Array.from(ids, BigInt), [1, ids.length]),
      style: new this.ort.Tensor('float32', style.slice(count * STYLE_SIZE, (count + 1) * STYLE_SIZE), [1, STYLE_SIZE]),
      speed: new this.ort.Tensor('float32', new Float32Array([request.speed ?? 1]), [1])
    });
    const waveform = output.waveform!.data as Float32Array;
    const durations = output.durations!.data as Float32Array;
    return split(waveform, durations, spans, request.utterances.map(u => u.pause));
  }
}

/** Splits one waveform into per-utterance segments using predicted token durations. */
export function split(waveform: Float32Array, durations: Float32Array, spans: ([number, number] | null)[][], pauses: number[]): SynthesizedSegment[] {
  const cumulative = new Float64Array(durations.length + 1);
  for (let i = 0; i < durations.length; i++) cumulative[i + 1] = cumulative[i]! + Math.max(0, durations[i]!);
  const total = cumulative[durations.length]!;
  const scale = total > 0 ? waveform.length / (total * SAMPLES_PER_FRAME) : 1;
  const time = (token: number) => (cumulative[Math.min(token, durations.length)]! * SAMPLES_PER_FRAME * scale) / SAMPLE_RATE;
  const length = waveform.length / SAMPLE_RATE;
  const bounds = spans.map(words => {
    const used = words.filter((span): span is [number, number] => !!span);
    return used.length ? [time(Math.min(...used.map(s => s[0]))), time(Math.max(...used.map(s => s[1])))] as const : null;
  });
  const segments: SynthesizedSegment[] = [];
  let previousEnd = 0;
  bounds.forEach((bound, u) => {
    const pause = Math.max(0, pauses[u] ?? 0);
    if (!bound) {
      segments.push({ samples: new Float32Array(Math.round(pause * SAMPLE_RATE)), wordTimes: spans[u]!.flatMap(() => [-1, -1]), duration: pause });
      return;
    }
    const next = bounds.slice(u + 1).find(b => b);
    const middle = next ? (bound[1] + next[0]) / 2 : length;
    const start = Math.max(previousEnd, bound[0] - LEAD, 0);
    const end = Math.min(bound[1] + TAIL, middle, length);
    previousEnd = end;
    const first = Math.round(start * SAMPLE_RATE);
    const last = Math.max(first, Math.round(end * SAMPLE_RATE));
    const speech = waveform.subarray(first, last);
    const silence = Math.max(0, pause - (end - bound[1]) - LEAD);
    const samples = new Float32Array(speech.length + Math.round(silence * SAMPLE_RATE));
    samples.set(speech);
    // Short fades avoid clicks where the waveform is cut.
    const fadeIn = Math.min(speech.length, Math.round(0.004 * SAMPLE_RATE));
    const fadeOut = Math.min(speech.length, Math.round(0.012 * SAMPLE_RATE));
    if (first > 0) for (let i = 0; i < fadeIn; i++) samples[i]! *= i / fadeIn;
    for (let i = 0; i < fadeOut; i++) samples[speech.length - 1 - i]! *= i / fadeOut;
    const wordTimes = spans[u]!.flatMap(span => span ? [Math.max(0, time(span[0]) - start), Math.max(0, time(span[1]) - start)] : [-1, -1]);
    segments.push({ samples, wordTimes, duration: samples.length / SAMPLE_RATE });
  });
  return segments;
}
