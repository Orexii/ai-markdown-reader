import { execFileSync } from 'node:child_process';
import { mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { bundle, copyNative } from './build.mjs';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const ALL = ['win32-x64', 'win32-arm64', 'linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64'];
const targets = process.argv.slice(2).length ? process.argv.slice(2) : ALL;
const { version } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
await bundle();
await mkdir(path.join(root, 'releases'), { recursive: true });
const vsce = path.join(root, 'node_modules', '@vscode', 'vsce', 'vsce');
for (const target of targets) {
  if (!ALL.includes(target)) throw new Error(`Unsupported target: ${target}`);
  await copyNative([target]);
  const output = path.join(root, 'releases', `clear-markdown-reader-${target}-${version}.vsix`);
  // Bundles already contain the JavaScript dependencies; only the native runtime is added per platform.
  // vsce runs the prepublish build; tell it which platform's runtime to include.
  execFileSync(process.execPath, [vsce, 'package', '--target', target, '--no-dependencies', '--skip-license', '--out', output],
    { cwd: root, stdio: 'inherit', env: { ...process.env, CMR_NATIVE_TARGETS: target } });
  const listing = execFileSync('unzip', ['-l', output], { encoding: 'utf8' });
  const [platform, arch] = target.split('-');
  if (!listing.includes(`bin/napi-v6/${platform}/${arch}/onnxruntime_binding.node`) || (listing.match(/bin\/napi-v6\/[^/]+\/[^/]+\/onnxruntime_binding\.node/g) ?? []).length !== 1) {
    throw new Error(`${output} does not contain exactly the ${target} runtime.`);
  }
}
await rm(path.join(root, 'bin'), { recursive: true, force: true });
