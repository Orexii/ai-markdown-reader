import { build } from 'esbuild';
import { cp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const ORT = path.join(root, 'node_modules', 'onnxruntime-node', 'bin', 'napi-v6');
// GPU providers are not needed for CPU speech and would add hundreds of megabytes.
const UNNEEDED = /DirectML|dxcompiler|dxil|cuda|tensorrt|providers_shared/i;

/** Copies the CPU ONNX Runtime files for each target (for example "win32-x64") next to the bundles. */
export async function copyNative(targets) {
  await rm(path.join(root, 'bin'), { recursive: true, force: true });
  for (const target of targets) {
    const [platform, arch] = target.split('-');
    const source = path.join(ORT, platform, arch);
    const destination = path.join(root, 'bin', 'napi-v6', platform, arch);
    await mkdir(destination, { recursive: true });
    const files = (await readdir(source)).filter(file => !UNNEEDED.test(file));
    if (!files.some(file => file.endsWith('.node'))) throw new Error(`No ONNX Runtime binding for ${target}`);
    for (const file of files) await cp(path.join(source, file), path.join(destination, file));
  }
}

// ONNX Runtime loads its platform binding at run time; resolve it from ../bin next to the bundle
// instead of letting esbuild expand the template into every platform's binary.
const nativeBinding = {
  name: 'native-binding',
  setup(builder) {
    builder.onLoad({ filter: /onnxruntime-node[\\/]dist[\\/]binding\.js$/ }, async args => {
      const source = await readFile(args.path, 'utf8');
      const patched = source.replace(/require\(`\.\.\/bin\/napi-v6\/\$\{process\.platform\}\/\$\{process\.arch\}\/onnxruntime_binding\.node`\)/,
        "require(require('node:path').join(__dirname, '..', 'bin', 'napi-v6', process.platform, process.arch, 'onnxruntime_binding.node'))");
      if (patched === source) throw new Error('Unexpected onnxruntime-node binding loader; update tools/build.mjs.');
      return { contents: patched, loader: 'js' };
    });
  }
};

export async function bundle() {
  const common = { bundle: true, platform: 'node', format: 'cjs', target: 'node20', sourcemap: false, logLevel: 'warning', plugins: [nativeBinding], logOverride: { 'unsupported-require-call': 'silent' } };
  await build({ ...common, entryPoints: [path.join(root, 'src/extension.ts')], outfile: path.join(root, 'dist/extension.js'), external: ['vscode'] });
  await build({ ...common, entryPoints: [path.join(root, 'src/engine/worker.ts')], outfile: path.join(root, 'dist/engine.js') });
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.join(root, 'tools', 'build.mjs')) {
  await bundle();
  const targets = (process.env.CMR_NATIVE_TARGETS || `${process.platform}-${process.arch}`).split(',').map(t => t.trim()).filter(Boolean);
  await copyNative(targets);
  console.log(`Built dist/ with native runtime for ${targets.join(', ')}`);
}
