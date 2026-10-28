// Downloads the pinned, verified Kokoro model and default voice for tests: node tools/fetch-model.mjs <dir> [best|compact]
// Layout: <dir>/onnx/<model file> and <dir>/voices/af_heart.bin. Requires `npx tsc` first (uses out/src/model.js).
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const { MODELS, MODEL_REPOSITORY, MODEL_REVISION, VOICES, downloadVerified } = require(path.join(root, 'out', 'src', 'model.js'));
const [directory = '.model', quality = 'compact'] = process.argv.slice(2);
const url = file => `https://huggingface.co/${MODEL_REPOSITORY}/resolve/${MODEL_REVISION}/${file}`;
const voice = VOICES.find(v => v.id === 'af_heart');
const files = [
  [MODELS[quality].file, MODELS[quality]],
  ['voices/af_heart.bin', { size: 522240, sha256: voice.sha256 }]
];
for (const [file, expected] of files) {
  const target = path.join(directory, file);
  if (existsSync(target) && statSync(target).size === expected.size) continue;
  let last = -1;
  await downloadVerified(url(file), target, expected, received => {
    const percent = Math.floor((received / expected.size) * 10) * 10;
    if (percent !== last) { last = percent; process.stdout.write(`${file}: ${percent}%\n`); }
  }, new AbortController().signal);
}
console.log(`Model files ready in ${directory}`);
