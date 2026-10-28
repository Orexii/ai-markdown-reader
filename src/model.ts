import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import * as path from 'node:path';

export const MODEL_REPOSITORY = 'onnx-community/Kokoro-82M-v1.0-ONNX-timestamped';
export const MODEL_REVISION = 'dd4401a9add81ac692d20e240d22ec9dda82cc29';

export type Quality = 'best' | 'compact';
interface Pinned { file: string; size: number; sha256: string }

export const MODELS: Record<Quality, Pinned> = {
  best: { file: 'onnx/model.onnx', size: 325532171, sha256: '651ea8291843a92276a4a003581a215cb07d15e47dde6fcfb1b768f9a1682054' },
  compact: { file: 'onnx/model_quantized.onnx', size: 92361055, sha256: 'c0c02b3299fd97c34ea92a98e6d41eaa1a739c8f77bf685aac34bd7b34c1132c' }
};

export interface VoiceInfo { id: string; name: string; accent: 'American' | 'British'; gender: 'Female' | 'Male'; grade: string; sha256: string }

const VOICE_SIZE = 522240;
// English voices with the official Kokoro grades (hexgrad/Kokoro-82M VOICES.md), best first.
export const VOICES: VoiceInfo[] = [
  ['af_heart', 'A', 'd583ccff3cdca2f7fae535cb998ac07e9fcb90f09737b9a41fa2734ec44a8f0b'],
  ['af_bella', 'A-', 'f69d836209b78eb8c66e75e3cda491e26ea838a3674257e9d4e5703cbaf55c8b'],
  ['af_nicole', 'B-', 'cd2191ab31b914ed7b318416b0e4440fdf392ddad9106a060819aa600a64f59a'],
  ['bf_emma', 'B-', '669fe0647f9dd04fcab92f1439a40eeb4c8b4ab1f82e4996fe3d918ce4a63b73'],
  ['am_michael', 'C+', '1d1f21dd8da39c30705cd4c75d039d265e9bc4a2a93ed09bc9e1b1225eb95ba1'],
  ['am_fenrir', 'C+', 'c27989f741f7ee34d273a39d8a595cc0837d35f5ced9a29b7cc162614616df43'],
  ['am_puck', 'C+', 'fcf73c989033e9233e0b98713eca600c8c74dcc1614b37009d5450ff4a2274a0'],
  ['af_aoede', 'C+', '4a004c33430762e2461eedb2013fad808ef4ab3121f5300f554476caf58d8361'],
  ['af_kore', 'C+', '9be5221b6a941c04b561959b8ff0b06e809444dcc4ab7e75a7b23606f691819e'],
  ['af_sarah', 'C+', '4409fbc125afabacc615d94db5398d847006a737b0247d6892b7a9a0007a2f0a'],
  ['bm_george', 'C', 'c4b235a4c1f2cd3b939fed08b899ce9385638b763f7b73a59616c4fc9bd6c9bc'],
  ['bm_fable', 'C', 'f889083196807b4adb15e9204252165f503b8d33d3982e681c52443c49d798f1'],
  ['bf_isabella', 'C', '3754352c4aaa46d17f27654ab7518d65b62ad6163a0f55a5f4330c2da2c4e94f'],
  ['af_alloy', 'C', 'c4a6b876047fd7fb472edf4ebd63cfac7c3b958a7cae7c106e8f038ca6308c45'],
  ['af_nova', 'C', '18778272caa0d0eebaea251c35fd635f038434f9eee5e691d02a174bd328414f'],
  ['af_sky', 'C-', '4435255c9744f3f31659e0d714ab7689bf65d9e77ec1cce060f083912614f0b9'],
  ['bm_lewis', 'D+', 'b8f671cef828c30e66fdf0b0756a76bba58f6bb3398cbbf27058642acbcedb97'],
  ['af_jessica', 'D', 'a240a5e3c15b43563d6e923bdca8ef5613a23471d9b77653694012435df23bd8'],
  ['af_river', 'D', '00a2bcf82b1d86e8f19902ede58c65ccf6c0e43b44b7d74fad54e5d8933c9c30'],
  ['am_echo', 'D', '3968b92c3c4cd1c4416dbded36c13eaa388a90d5788d02a13e4d781f5f8cf3c3'],
  ['am_eric', 'D', 'e8b5be17edd1e3636901ce7598baafe2dc8dd8ff707a0c23bf9e461add7e2832'],
  ['am_liam', 'D', '52403be32fd047c6a44517cb0bcd6b134f2a18baa73e70ef41651e0eab921ade'],
  ['am_onyx', 'D', 'da5d135b424164916d75a68ffb4c2abce3d7d5ccc82dd1ee6cf447ce286145e6'],
  ['bf_alice', 'D', '08afa6ba24da61ea5e8efa139e5aadc938d83f0a6da5a900adaf763ac1da5573'],
  ['bf_lily', 'D', '5e0ee32ebe64a467124976b14e69590746f1c4ce41a12b587a50c862edfea335'],
  ['bm_daniel', 'D', '6b3194bbceffb746733cbc22c8f593dd44e401a71d53895a2dca891bc595a1e8'],
  ['am_santa', 'D-', '61150cf726ab6c5ed7a99f90a304f91f5a72c00c592e89ec94e5df11c319227a'],
  ['am_adam', 'F+', '162b035ed91cfc48b6046982184c645f72edcdd1b82843347f605d7bf7b15716']
].map(([id, grade, sha256]) => ({
  id: id!, grade: grade!, sha256: sha256!,
  name: id!.slice(3).replace(/^./, ch => ch.toUpperCase()),
  accent: id!.startsWith('b') ? 'British' : 'American',
  gender: id![1] === 'f' ? 'Female' : 'Male'
}));

export const DEFAULT_VOICE = 'af_heart';

export function voiceInfo(id: string): VoiceInfo | undefined {
  return VOICES.find(voice => voice.id === id);
}

export type Progress = (received: number, total: number) => void;

function url(file: string): string {
  return `https://huggingface.co/${MODEL_REPOSITORY}/resolve/${MODEL_REVISION}/${file}`;
}

/** Downloads a pinned file, verifying size and SHA-256 before atomically moving it into place. */
export async function downloadVerified(source: string, target: string, expected: { size: number; sha256: string },
  progress: Progress, signal: AbortSignal, fetcher: typeof fetch = fetch): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true });
  const partial = `${target}.partial`;
  const stall = new AbortController();
  const abort = () => stall.abort();
  signal.addEventListener('abort', abort, { once: true });
  let timer: NodeJS.Timeout | undefined;
  const watchdog = () => {
    clearTimeout(timer);
    timer = setTimeout(() => stall.abort(new Error('Download stalled for 60 seconds.')), 60_000);
  };
  try {
    watchdog();
    const response = await fetcher(source, { signal: stall.signal, redirect: 'follow' });
    if (!response.ok || !response.body) throw new Error(`Download failed: HTTP ${response.status} ${response.statusText}`.trim());
    const hash = createHash('sha256');
    const output = createWriteStream(partial);
    const closed = new Promise<void>((resolve, reject) => {
      output.on('close', resolve);
      output.on('error', reject);
    });
    let received = 0;
    try {
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        watchdog();
        received += chunk.length;
        if (received > expected.size) throw new Error('Download is larger than expected.');
        hash.update(chunk);
        if (!output.write(chunk)) await new Promise<void>(resolve => output.once('drain', resolve));
        progress(received, expected.size);
      }
    } finally {
      output.end();
      await closed;
    }
    const digest = hash.digest('hex');
    if (received !== expected.size || digest !== expected.sha256) {
      throw new Error(`Downloaded file failed verification (expected ${expected.size} bytes, received ${received}).`);
    }
    await rename(partial, target);
  } catch (error) {
    await rm(partial, { force: true });
    if (signal.aborted) throw new Error('Download cancelled.');
    if (stall.signal.aborted && stall.signal.reason instanceof Error) throw stall.signal.reason;
    throw error;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
  }
}

async function present(file: string, size: number): Promise<boolean> {
  try {
    return (await stat(file)).size === size;
  } catch {
    return false;
  }
}

/** Natural-voice files stored in the extension's global storage. */
export class ModelStore {
  private installing: Promise<void> | undefined;

  constructor(readonly root: string, private readonly fetcher: typeof fetch = fetch) {}

  modelPath(quality: Quality): string {
    return path.join(this.root, path.basename(MODELS[quality].file));
  }

  get voicesDir(): string {
    return path.join(this.root, 'voices');
  }

  hasModel(quality: Quality): Promise<boolean> {
    return present(this.modelPath(quality), MODELS[quality].size);
  }

  hasVoice(id: string): Promise<boolean> {
    return present(path.join(this.voicesDir, `${id}.bin`), VOICE_SIZE);
  }

  /** Installs the model and voice; concurrent callers share one download. */
  install(quality: Quality, voice: string, progress: Progress, signal: AbortSignal): Promise<void> {
    if (this.installing) return this.installing;
    this.installing = (async () => {
      const info = voiceInfo(voice) ?? voiceInfo(DEFAULT_VOICE)!;
      const needModel = !await this.hasModel(quality);
      const needVoice = !await this.hasVoice(info.id);
      const total = (needModel ? MODELS[quality].size : 0) + (needVoice ? VOICE_SIZE : 0);
      let done = 0;
      if (needVoice) {
        await downloadVerified(url(`voices/${info.id}.bin`), path.join(this.voicesDir, `${info.id}.bin`),
          { size: VOICE_SIZE, sha256: info.sha256 }, received => progress(done + received, total), signal, this.fetcher);
        done += VOICE_SIZE;
      }
      if (needModel) {
        await downloadVerified(url(MODELS[quality].file), this.modelPath(quality), MODELS[quality],
          received => progress(done + received, total), signal, this.fetcher);
      }
    })().finally(() => { this.installing = undefined; });
    return this.installing;
  }

  async installVoice(voice: string, signal: AbortSignal): Promise<void> {
    const info = voiceInfo(voice);
    if (!info) throw new Error(`Unknown voice: ${voice}`);
    if (await this.hasVoice(info.id)) return;
    await downloadVerified(url(`voices/${info.id}.bin`), path.join(this.voicesDir, `${info.id}.bin`),
      { size: VOICE_SIZE, sha256: info.sha256 }, () => undefined, signal, this.fetcher);
  }

  async remove(): Promise<void> {
    await rm(this.root, { recursive: true, force: true });
  }
}
