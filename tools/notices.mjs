// Regenerates THIRD_PARTY_NOTICES.md from the packages the bundles actually include.
import { build } from 'esbuild';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const packages = new Set();
for (const entry of ['src/extension.ts', 'src/engine/worker.ts']) {
  const result = await build({ entryPoints: [path.join(root, entry)], bundle: true, platform: 'node', format: 'cjs', write: false, metafile: true, external: ['vscode', '*.node'], logLevel: 'silent', outfile: 'unused.js' })
    .catch(error => ({ metafile: error.metafile }));
  for (const input of Object.keys(result.metafile?.inputs ?? {})) {
    const match = /node_modules\/((?:@[^/]+\/)?[^/]+)/.exec(input);
    if (match) packages.add(match[1]);
  }
}
const sections = [...packages].sort().map(name => {
  const directory = path.join(root, 'node_modules', name);
  const manifest = JSON.parse(readFileSync(path.join(directory, 'package.json'), 'utf8'));
  const file = ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'license'].map(candidate => path.join(directory, candidate)).find(existsSync);
  let text = file ? readFileSync(file, 'utf8').trim() : '';
  if (name.startsWith('onnxruntime-')) text = 'See licenses/onnxruntime-LICENSE.txt (MIT, Copyright (c) Microsoft Corporation) and licenses/onnxruntime-ThirdPartyNotices.txt.';
  if (/Apache License/.test(text)) text = 'Apache License 2.0; the full text is in licenses/Apache-2.0.txt.';
  const repository = typeof manifest.repository === 'string' ? manifest.repository : manifest.repository?.url ?? '';
  return `## ${name} ${manifest.version}\n\nLicense: ${manifest.license}. Source: ${repository.replace(/^git\+/, '')}\n\n${text ? `\`\`\`\n${text}\n\`\`\`` : ''}`;
});
writeFileSync(path.join(root, 'THIRD_PARTY_NOTICES.md'), `# Third-party notices

AI Markdown Reader's own source code is MIT-licensed (see LICENSE). Packaged releases (.vsix) also
contain the components below.

**eSpeak NG.** The bundled phonemizer package contains eSpeak NG compiled to WebAssembly. eSpeak NG is
licensed under the GNU General Public License version 3 or later, so each packaged release, taken as a
whole, is distributed under GPL-3.0-or-later (licenses/GPL-3.0.txt). The complete corresponding source is
this repository (https://github.com/Orexii/ai-markdown-reader), phonemizer.js
(https://github.com/xenova/phonemizer.js) and eSpeak NG (https://github.com/espeak-ng/espeak-ng).

**Kokoro-82M.** The natural voice model and voice files are not included in releases. They are downloaded
on request from https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX-timestamped (an ONNX conversion
of https://huggingface.co/hexgrad/Kokoro-82M) and are licensed under the Apache License 2.0
(licenses/Apache-2.0.txt).

**misaki.** lexicon/us.json and lexicon/gb.json are the English pronunciation lexicons of misaki
(https://github.com/hexgrad/misaki, commit ${readFileSync(path.join(root, 'lexicon', 'MISAKI_COMMIT'), 'utf8').trim()}), Copyright hexgrad, licensed under the
Apache License 2.0 (licenses/Apache-2.0.txt). src/engine/lexicon.ts and the toMisaki mapping in src/engine/kokoro.ts
are ports of misaki's word lookup and eSpeak fallback rules.

**kokoro.js.** The eSpeak phoneme corrections in src/engine/kokoro.ts and the number and currency rules in
src/engine/pronounce.ts follow the approach of kokoro.js (https://github.com/hexgrad/kokoro, Apache-2.0).

**ONNX Runtime.** Platform packages include the ONNX Runtime ${JSON.parse(readFileSync(path.join(root, 'node_modules/onnxruntime-node/package.json'), 'utf8')).version}
CPU library and Node.js binding (MIT, Microsoft), with the notices in licenses/onnxruntime-ThirdPartyNotices.txt.

${sections.join('\n\n')}
`);
console.log(`Wrote notices for ${packages.size} packages.`);
