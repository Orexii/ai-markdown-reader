import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { appendSilence, encodeWav, parseWav } from '../src/engine/wav';

test('encoded WAV round-trips through the parser with clamped 16-bit samples', () => {
  const wav = encodeWav(new Float32Array([0, 1, -1, 2, -2, 0.5]), 24000);
  const info = parseWav(wav);
  assert.deepEqual({ ...info }, { channels: 1, sampleRate: 24000, blockAlign: 2, bits: 16, dataOffset: 44, dataLength: 12 });
  const view = new DataView(wav.buffer);
  assert.deepEqual([1, 2, 3, 4].map(i => view.getInt16(44 + i * 2, true)), [32767, -32768, 32767, -32768]);
});

test('silence is appended without changing the speech', () => {
  const original = encodeWav(new Float32Array(24000).fill(0.25), 24000);
  const { wav, speechDuration, duration } = appendSilence(original, 0.5);
  assert.equal(speechDuration, 1);
  assert.equal(duration, 1.5);
  assert.equal(parseWav(wav).dataLength, 72000);
  assert.deepEqual(wav.subarray(44, 44 + 48000), original.subarray(44));
  assert.ok(wav.subarray(44 + 48000).every(byte => byte === 0));
});

test('WAV files with extra chunks are understood and invalid audio is rejected', () => {
  const plain = encodeWav(new Float32Array(10), 16000);
  const withList = new Uint8Array(plain.length + 12);
  withList.set(plain.subarray(0, 36));
  withList.set([...'LIST'].map(c => c.charCodeAt(0)), 36);
  new DataView(withList.buffer).setUint32(40, 3, true);
  withList.set(plain.subarray(36), 48);
  assert.equal(parseWav(withList).dataOffset, 56);
  assert.throws(() => parseWav(new Uint8Array(50)), /Not a WAV/);
  const float = encodeWav(new Float32Array(4), 8000);
  new DataView(float.buffer).setUint16(20, 3, true);
  assert.throws(() => parseWav(float), /Only PCM/);
});
