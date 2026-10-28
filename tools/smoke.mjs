// Checks the bundled engine and this platform's native runtime: node tools/smoke.mjs <model dir>
import { fork } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { bundle, copyNative } from './build.mjs';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const directory = path.resolve(process.argv[2] ?? '.model');
const model = ['model_quantized.onnx', 'model.onnx'].map(file => path.join(directory, 'onnx', file)).find(existsSync);
if (!model) throw new Error(`No model in ${directory}/onnx`);
await bundle();
await copyNative([`${process.platform}-${process.arch}`]);
const child = fork(path.join(root, 'dist', 'engine.js'), [], { serialization: 'advanced', stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
const call = message => new Promise((resolve, reject) => {
  child.once('message', reply => (reply.type === 'ok' ? resolve(reply) : reject(new Error(reply.message))));
  child.send({ id: 1, ...message });
});
const started = Date.now();
await call({ type: 'load', modelPath: model, voicesDir: path.join(directory, 'voices'), threads: 2 });
const reply = await call({ type: 'synthesize', request: { voice: 'af_heart', utterances: [
  { words: [{ text: 'Platform', sep: ' ' }, { text: 'check', sep: '.' }], pause: 0.3 },
  { words: [{ text: 'The', sep: ' ' }, { text: 'ANF', sep: ' ' }, { text: 'reader', sep: ' ' }, { text: 'works', sep: '.' }], pause: 0.5 }
] } });
for (const segment of reply.segments) {
  const header = Buffer.from(segment.wav.subarray(0, 12)).toString('latin1');
  if (!header.startsWith('RIFF') || !header.endsWith('WAVE') || segment.duration < 0.5) throw new Error('Invalid audio from the bundled engine.');
}
child.send({ id: 2, type: 'shutdown' });
console.log(`Bundled engine on ${process.platform}-${process.arch}: ${reply.segments.length} passages in ${Date.now() - started} ms.`);
