// Runs test/extension-host.ts inside a real VS Code with a throwaway profile.
// Usage: node tools/e2e.mjs --code <VS Code executable> --model <dir with onnx/model*.onnx and voices/af_heart.bin> [--quality best|compact] [--mode play|gesture] [--screenshots <dir>]
// play: Playwright drives VS Code and plays everything. gesture: a normal launch, checking the player asks for a click.
// From WSL, pass the Windows executable (for example "/mnt/c/Program Files/Microsoft VS Code/Code.exe").
import { execFileSync, spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bundle, copyNative } from './build.mjs';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, i, all) => (value.startsWith('--') ? [...pairs, [value.slice(2), all[i + 1]]] : pairs), []));
if (!args.code || !args.model) throw new Error('Usage: node tools/e2e.mjs --code <VS Code executable> --model <model dir> [--quality best|compact]');
const quality = args.quality === 'compact' ? 'compact' : 'best';
const modelFile = quality === 'compact' ? 'model_quantized.onnx' : 'model.onnx';
const wslToWindows = process.platform === 'linux' && args.code.endsWith('.exe');
const toHost = file => (wslToWindows ? execFileSync('wslpath', ['-w', file], { encoding: 'utf8' }).trim() : file);
const target = wslToWindows ? 'win32-x64' : `${process.platform}-${process.arch}`;

async function hostTemp() {
  if (!wslToWindows) return mkdtemp(path.join(os.tmpdir(), 'cmr-e2e-'));
  const windows = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    '$p = Join-Path $env:TEMP ("cmr-e2e-" + [guid]::NewGuid()); New-Item -ItemType Directory -Path $p | Out-Null; $p'], { encoding: 'utf8' }).trim();
  return execFileSync('wslpath', ['-u', windows], { encoding: 'utf8' }).trim();
}

await bundle();
await copyNative([target]);
execFileSync(process.execPath, [path.join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', root], { stdio: 'inherit' });
const temp = await hostTemp();
try {
  const extension = path.join(temp, 'extension');
  for (const item of ['package.json', 'dist', 'media', 'scripts', 'bin', 'out', 'examples', 'lexicon']) await cp(path.join(root, item), path.join(extension, item), { recursive: true });
  const storage = path.join(temp, 'profile', 'User', 'globalStorage', 'orexii.clear-markdown-reader', 'kokoro-82m-v1.0');
  await mkdir(path.join(storage, 'voices'), { recursive: true });
  await cp(path.join(args.model, 'onnx', modelFile), path.join(storage, modelFile));
  await cp(path.join(args.model, 'voices', 'af_heart.bin'), path.join(storage, 'voices', 'af_heart.bin'));
  await writeFile(path.join(temp, 'profile', 'User', 'settings.json'), JSON.stringify({
    'clearMarkdown.naturalQuality': quality, 'security.workspace.trust.enabled': false, 'workbench.startupEditor': 'none'
  }));
  const vscodeArgs = [
    '--user-data-dir', toHost(path.join(temp, 'profile')), '--extensions-dir', toHost(path.join(temp, 'extensions')),
    '--disable-extensions', '--disable-gpu', '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust',
    `--extensionDevelopmentPath=${toHost(extension)}`, `--extensionTestsPath=${toHost(path.join(extension, 'out', 'test', 'extension-host.js'))}`
  ];
  // Playwright drives VS Code so the test can click in the webview; it runs under VS Code's own
  // Node runtime on the same OS as VS Code (needed when VS Code runs on Windows and this script in WSL).
  let code;
  if (args.mode === 'gesture') {
    const env = { ...process.env, CMR_E2E_EXPECT_GESTURE: '1', ELECTRON_RUN_AS_NODE: undefined, WSLENV: [process.env.WSLENV, 'CMR_E2E_EXPECT_GESTURE'].filter(Boolean).join(':') };
    code = spawn(args.code, vscodeArgs, { stdio: ['ignore', 'pipe', 'pipe'], env });
  } else {
    await cp(path.join(root, 'node_modules', 'playwright-core'), path.join(temp, 'driver', 'node_modules', 'playwright-core'), { recursive: true });
    await cp(path.join(root, 'tools', 'e2e-driver.cjs'), path.join(temp, 'driver', 'e2e-driver.cjs'));
    const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', WSLENV: [process.env.WSLENV, 'ELECTRON_RUN_AS_NODE'].filter(Boolean).join(':') };
    const driverArgs = [toHost(path.join(temp, 'driver', 'e2e-driver.cjs')), JSON.stringify([toHost(args.code), ...vscodeArgs])];
    if (args.screenshots) driverArgs.push(toHost(path.resolve(args.screenshots)));
    code = spawn(args.code, driverArgs, { stdio: ['ignore', 'pipe', 'pipe'], env });
  }
  let output = '';
  code.stdout.on('data', data => { output += data; });
  code.stderr.on('data', data => { output += data; });
  const exit = await new Promise(resolve => code.on('close', resolve));
  const relevant = output.split(/\r?\n/).filter(line => /E2E:|Natural voice|Read Aloud Preview:|Background:|Extension host:|Error|assert|Timed out|failed/i.test(line) && !/DeprecationWarning|mutex|agentHost|CloudSandbox|Unknown channel|proposal|GPU|gpu_|ERROR:/i.test(line));
  console.log(relevant.join('\n'));
  if (exit !== 0) {
    if (existsSync(path.join(temp, 'profile', 'logs'))) console.log(`Logs kept at ${path.join(temp, 'profile', 'logs')}`);
    throw new Error(`VS Code integration test failed with exit code ${exit}.`);
  }
} finally {
  if (!process.env.CMR_KEEP_E2E) await rm(temp, { recursive: true, force: true });
  await rm(path.join(root, 'bin'), { recursive: true, force: true });
}
