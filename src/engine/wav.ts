/** Encodes mono float samples as 16-bit PCM WAV. */
export function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const text = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i));
  };
  text(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const sample = Math.max(-1, Math.min(1, samples[i]!));
    view.setInt16(44 + i * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
  }
  return new Uint8Array(buffer);
}

export interface WavInfo { sampleRate: number; channels: number; bits: number; blockAlign: number; dataOffset: number; dataLength: number }

/** Reads the format and data location of a PCM WAV file. */
export function parseWav(bytes: Uint8Array): WavInfo {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (offset: number) => String.fromCharCode(...bytes.subarray(offset, offset + 4));
  if (bytes.length < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('Not a WAV file.');
  let format: Omit<WavInfo, 'dataOffset' | 'dataLength'> | undefined;
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const id = tag(offset);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === 'fmt ' && size >= 16) {
      if (view.getUint16(body, true) !== 1) throw new Error('Only PCM WAV audio is supported.');
      format = { channels: view.getUint16(body + 2, true), sampleRate: view.getUint32(body + 4, true), blockAlign: view.getUint16(body + 12, true), bits: view.getUint16(body + 14, true) };
    } else if (id === 'data' && format) {
      return { ...format, dataOffset: body, dataLength: Math.min(size, bytes.length - body) };
    }
    offset = body + size + (size % 2);
  }
  throw new Error('WAV file has no audio data.');
}

/** Returns a WAV with trailing silence appended, plus its speech and total durations. */
export function appendSilence(bytes: Uint8Array, seconds: number): { wav: Uint8Array; speechDuration: number; duration: number } {
  const info = parseWav(bytes);
  const bytesPerSecond = info.sampleRate * info.blockAlign;
  const extra = Math.round(Math.max(0, seconds) * info.sampleRate) * info.blockAlign;
  const total = info.dataLength + extra;
  const wav = new Uint8Array(44 + total);
  const view = new DataView(wav.buffer);
  wav.set([...'RIFF'].map(c => c.charCodeAt(0)), 0);
  view.setUint32(4, 36 + total, true);
  wav.set([...'WAVEfmt '].map(c => c.charCodeAt(0)), 8);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, info.channels, true);
  view.setUint32(24, info.sampleRate, true);
  view.setUint32(28, bytesPerSecond, true);
  view.setUint16(32, info.blockAlign, true);
  view.setUint16(34, info.bits, true);
  wav.set([...'data'].map(c => c.charCodeAt(0)), 36);
  view.setUint32(40, total, true);
  wav.set(bytes.subarray(info.dataOffset, info.dataOffset + info.dataLength), 44);
  if (info.bits === 8) wav.fill(128, 44 + info.dataLength);
  return { wav, speechDuration: info.dataLength / bytesPerSecond, duration: total / bytesPerSecond };
}
