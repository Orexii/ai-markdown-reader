import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { buildDocument } from '../src/document';
import { Scheduler, spokenLength } from '../src/scheduler';
import type { AudioSegment, SpeechEngine, SpeechInput } from '../src/engine/client';

class FakeEngine implements SpeechEngine {
  readonly kind = 'natural';
  readonly calls: number[][] = [];
  failNext = false;
  release: (() => void) | undefined;
  constructor(readonly batchChars = 170, private readonly hold = false) {}
  async synthesize(inputs: SpeechInput[]): Promise<AudioSegment[]> {
    this.calls.push(inputs.map(input => input.words.length));
    if (this.hold) await new Promise<void>(resolve => { this.release = resolve; });
    await new Promise(resolve => setTimeout(resolve, 1));
    if (this.failNext) {
      this.failNext = false;
      throw new Error('boom');
    }
    return inputs.map(() => ({ wav: new Uint8Array(100), duration: 1, wordTimes: [] }));
  }
  dispose(): void {}
}

const doc = buildDocument([
  '# Short',
  'A first paragraph that is long enough to stand on its own when it is spoken aloud by the voice.',
  'Tiny.',
  'Another reasonably long paragraph that follows the tiny one and keeps the reader company for a while.',
  'Yet another paragraph, so that prefetching has something more to do after the first requests are done.'
].join('\n\n'));

function scheduler(engine: SpeechEngine) {
  const delivered: number[] = [];
  const failed: [number, string][] = [];
  const instance = new Scheduler({
    engine, utterances: doc.utterances, voice: 'af_heart', dictionary: [],
    deliver: index => delivered.push(index), fail: (index, error) => failed.push([index, error.message])
  });
  return { instance, delivered, failed };
}

const settle = () => new Promise(resolve => setTimeout(resolve, 30));

test('the urgent passage is synthesized first, combining a short heading with what follows', async () => {
  const engine = new FakeEngine();
  const { instance, delivered } = scheduler(engine);
  instance.need([0, 1, 2, 3, 4]);
  await settle();
  assert.deepEqual(delivered, [0, 1, 2, 3, 4]);
  assert.equal(engine.calls[0]!.length, 2, 'short heading merged with the next passage');
  const first = spokenLength(doc.utterances[0]!) + spokenLength(doc.utterances[1]!);
  assert.ok(first < 250);
  assert.ok(engine.calls.length < 5, 'later passages are batched');
});

test('cached audio is delivered again without new synthesis, and in-flight work is not duplicated', async () => {
  const engine = new FakeEngine(170, true);
  const { instance, delivered } = scheduler(engine);
  instance.need([3]);
  instance.need([3]);
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(engine.calls.length, 1);
  engine.release!();
  await settle();
  assert.deepEqual(delivered, [3]);
  instance.need([3]);
  assert.deepEqual(delivered, [3, 3]);
  assert.equal(engine.calls.length, 1);
});

test('a jump re-prioritizes queued work and failures are reported without stopping the queue', async () => {
  const engine = new FakeEngine(0);
  const { instance, delivered, failed } = scheduler(engine);
  engine.failNext = true;
  instance.need([0, 1, 2]);
  instance.need([4, 3]);
  await settle();
  assert.deepEqual(failed, [[0, 'boom']]);
  assert.deepEqual(delivered, [4, 3]);
  assert.ok(engine.calls.every(call => call.length === 1), 'engines without batching get one passage per request');
});

test('disposing stops delivery', async () => {
  const engine = new FakeEngine(170, true);
  const { instance, delivered } = scheduler(engine);
  instance.need([1, 2]);
  await new Promise(resolve => setTimeout(resolve, 5));
  instance.dispose();
  engine.release!();
  await settle();
  assert.deepEqual(delivered, []);
});

test('batches stay small while little audio is buffered and grow once playback is safely ahead', async () => {
  const long = buildDocument(Array.from({ length: 12 }, (_, i) => `Sentence number ${i + 1} is a reasonably long sentence for testing batches.`).join(' '));
  const sizes = (calls: number[][]) => calls.map(call => call.length);
  const run = async (ahead: number) => {
    const engine = new FakeEngine();
    const logs: string[] = [];
    const instance = new Scheduler({
      engine, utterances: long.utterances, voice: 'af_heart', dictionary: [], deliver: () => undefined, fail: () => undefined, log: message => logs.push(message)
    });
    instance.need(long.utterances.map((_, i) => i).slice(0, 4), ahead, 2);
    await settle();
    instance.dispose();
    return { calls: engine.calls, logs };
  };
  const starved = await run(0);
  const chars = spokenLength(long.utterances[0]!);
  assert.ok(chars > 40 && chars * 2 > 90, 'each sentence is long enough to stand alone');
  assert.deepEqual(sizes(starved.calls), [1, 1, 1, 1], 'nothing buffered: one sentence at a time');
  const comfortable = await run(60);
  assert.ok(sizes(comfortable.calls)[0]! > 1, 'a minute buffered: full batches for better prosody');
});
