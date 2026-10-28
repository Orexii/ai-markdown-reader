import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { KokoroModel, SAMPLE_RATE, split, type SynthesisRequest } from '../src/engine/kokoro';
import { spell } from '../src/engine/pronounce';
import { VOCAB } from '../src/engine/vocab';

const NAMES = Object.fromEntries(Object.entries(VOCAB).map(([ch, id]) => [id, ch]));

class FakeTensor {
  constructor(readonly type: string, readonly data: BigInt64Array | Float32Array, readonly dims: number[]) {}
}

interface Feeds { input_ids: FakeTensor; style: FakeTensor; speed: FakeTensor }

async function fixture(join = false) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cmr-kokoro-'));
  const voice = new Float32Array(510 * 256);
  for (let row = 0; row < 510; row++) voice.fill(row, row * 256, (row + 1) * 256);
  await writeFile(path.join(directory, 'af_heart.bin'), new Uint8Array(voice.buffer));
  const runs: Feeds[] = [];
  const ort = {
    Tensor: FakeTensor,
    InferenceSession: {
      create: async () => ({
        run: async (feeds: Feeds) => {
          runs.push(feeds);
          const ids = [...(feeds.input_ids.data as BigInt64Array)].map(Number);
          // Every token lasts two frames, except a longer leading silence.
          const durations = Float32Array.from(ids, (_, i) => (i === 0 ? 12 : 2));
          const samples = durations.reduce((a, b) => a + b, 0) * 600;
          return { waveform: { data: new Float32Array(samples).fill(0.3) }, durations: { data: durations } };
        }
      })
    }
  };
  const phonemize = async (text: string) => {
    let words = text.toLowerCase().replace(/g/g, 'ɡ').split(/\s+/).filter(Boolean);
    if (join) words = words.join(' ').replace(/\bin the\b/g, 'inðə').split(' ');
    return [words.join(' ')];
  };
  const model = await KokoroModel.load({ ort: ort as never, modelPath: 'unused', voicesDir: directory, threads: 1, phonemize });
  return { model, runs, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

const request = (...utterances: [string, number][]): SynthesisRequest => ({
  voice: 'af_heart',
  utterances: utterances.map(([text, pause]) => {
    const parts = text.split(' ');
    return {
      pause,
      words: parts.map((part, k) => {
        const match = /^(.*?)([,.]?)$/.exec(part)!;
        return { text: match[1]!, sep: k === parts.length - 1 ? (match[2] || '.') : match[2] ? `${match[2]} ` : ' ' };
      })
    };
  })
});

const decode = (feeds: Feeds) => [...(feeds.input_ids.data as BigInt64Array)].map(id => NAMES[Number(id)]).join('');

test('phoneme tokens are framed, punctuated and use exact acronym phonemes and the matching style row', async () => {
  const { model, runs, cleanup } = await fixture();
  try {
    await model.synthesize(request(['The ANF team, now.', 0.3]));
    const text = decode(runs[0]!);
    assert.equal(text, `$the ${spell('ANF')} team, now.$`);
    const count = (runs[0]!.input_ids.data as BigInt64Array).length - 2;
    assert.ok((runs[0]!.style.data as Float32Array).every(value => value === count));
    assert.deepEqual([...(runs[0]!.speed.data as Float32Array)], [1]);
  } finally {
    await cleanup();
  }
});

test('segments split per utterance with the requested pauses and relative word times', async () => {
  const { model, cleanup } = await fixture();
  try {
    const segments = await model.synthesize(request(['First sentence.', 0.3], ['Second one here.', 0.6]));
    assert.equal(segments.length, 2);
    for (const [k, segment] of segments.entries()) {
      const times = segment.wordTimes;
      assert.ok(Math.abs(times[0]! - 0.03) < 0.01, `segment ${k} starts after a short lead-in`);
      for (let i = 2; i < times.length; i += 2) assert.ok(times[i]! >= times[i - 1]! - 1e-9);
      const end = times.at(-1)!;
      const pause = k === 0 ? 0.3 : 0.6;
      assert.ok(Math.abs(segment.duration - (end + pause - 0.03)) < 0.02, `segment ${k} pause`);
      assert.equal(segment.samples.length, Math.round(segment.duration * SAMPLE_RATE));
    }
  } finally {
    await cleanup();
  }
});

test('words that eSpeak joins in context still get ordered timings', async () => {
  const { model, cleanup } = await fixture(true);
  try {
    const [segment] = await model.synthesize(request(['look in the box.', 0.2]));
    const times = segment!.wordTimes;
    assert.equal(times.length, 8);
    assert.ok(times.every(t => t >= 0));
    for (let i = 2; i < times.length; i += 2) assert.ok(times[i]! >= times[i - 2]!, 'starts are ordered');
    assert.ok(times[3]! <= times[5]! && times[2]! < times[4]!, '"in" precedes "the" inside the joined word');
  } finally {
    await cleanup();
  }
});

test('requests over the token limit are split and recombined transparently', async () => {
  const { model, runs, cleanup } = await fixture();
  try {
    const long = Array.from({ length: 140 }, (_, i) => `word${'abcdefhij'[i % 9]}`).join(' ');
    const [segment] = await model.synthesize(request([`${long}.`, 0.4]));
    assert.ok(runs.length >= 2);
    assert.ok(runs.every(run => (run.input_ids.data as BigInt64Array).length <= 512));
    assert.equal(segment!.wordTimes.length, 280);
    assert.ok(segment!.wordTimes.every(t => t >= 0));
    for (let i = 2; i < segment!.wordTimes.length; i += 2) assert.ok(segment!.wordTimes[i]! >= segment!.wordTimes[i - 2]!);
    const many = await model.synthesize(request(...Array.from({ length: 8 }, (): [string, number] => [`${long.slice(0, 300)}.`, 0.1])));
    assert.equal(many.length, 8);
  } finally {
    await cleanup();
  }
});

test('unknown voices and damaged voice files are rejected with clear errors', async () => {
  const { model, cleanup } = await fixture();
  try {
    await assert.rejects(model.synthesize({ ...request(['Hi.', 0.1]), voice: '../../secret' }), /Unknown voice/);
    await assert.rejects(model.synthesize({ ...request(['Hi.', 0.1]), voice: 'af_bella' }), /ENOENT/);
  } finally {
    await cleanup();
  }
});

test('utterances without sound become silence and cuts are faded', () => {
  const waveform = new Float32Array(48000).fill(0.5);
  const durations = new Float32Array([10, 20, 20, 10, 20, 20]);
  const segments = split(waveform, durations, [[[1, 3]], [null], [[4, 6]]], [0.2, 0.5, 0.1]);
  assert.equal(segments.length, 3);
  assert.deepEqual(segments[1]!.wordTimes, [-1, -1]);
  assert.equal(segments[1]!.duration, 0.5);
  assert.ok(segments[1]!.samples.every(sample => sample === 0));
  assert.equal(segments[0]!.samples[0], 0, 'fade in at the cut');
  const last = segments[2]!.samples.findLastIndex(sample => sample !== 0);
  assert.ok(last > 0 && Math.abs(segments[2]!.samples[last]!) < 0.01, 'fade out before the pause');
});

test('real Kokoro model produces timed speech', {
  skip: process.env.CMR_MODEL_DIR ? false : 'Set CMR_MODEL_DIR to a directory with onnx/model*.onnx and voices/af_heart.bin.'
}, async () => {
  const ort = await import('onnxruntime-node');
  const { phonemize } = await import('phonemizer');
  const directory = process.env.CMR_MODEL_DIR!;
  const file = ['model_quantized.onnx', 'model.onnx'].map(name => path.join(directory, 'onnx', name))
    .find(candidate => require('node:fs').existsSync(candidate))!;
  const model = await KokoroModel.load({ ort: ort as never, modelPath: file, voicesDir: path.join(directory, 'voices'), threads: 4, phonemize });
  const segments = await model.synthesize(request(['The ANF team reads tables, row by row.', 0.3], ['Mail. State: ready.', 0.5]));
  assert.equal(segments.length, 2);
  for (const segment of segments) {
    assert.ok(segment.duration > 0.8);
    let energy = 0;
    for (const sample of segment.samples) energy += sample * sample;
    assert.ok(Math.sqrt(energy / segment.samples.length) > 0.01, 'audible speech');
    const times = segment.wordTimes;
    for (let i = 0; i < times.length; i += 2) {
      assert.ok(times[i]! >= 0 && times[i + 1]! >= times[i]! && times[i + 1]! <= segment.duration + 1e-6);
      if (i) assert.ok(times[i]! >= times[i - 2]!);
    }
  }
});
