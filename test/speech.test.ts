import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { NativeSpeech, runProcess, validateWave } from '../src/speech';

test('process arguments are literal, not shell interpolation', async () => {
  const content = '"; $(echo unsafe) & <speak>hello</speak>';
  const { stdout } = await runProcess(process.execPath, ['-e', 'process.stdout.write(process.argv[1])', content]);
  assert.equal(stdout, content);
});

test('process failures retain actionable diagnostics', async () => {
  await assert.rejects(runProcess(process.execPath, ['-e', 'console.error("no voice"); process.exit(7)']), /code 7: no voice/);
  await assert.rejects(runProcess(path.join(os.tmpdir(), 'clear-markdown-missing-executable-123'), []), { code: 'ENOENT' });
});

test('speech generation can be cancelled', async () => {
  const controller = new AbortController();
  const promise = runProcess(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], controller.signal);
  controller.abort();
  await assert.rejects(promise, /abort|cancel/i);
});

test('malformed audio is rejected before playback', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'clear-reader-test-'));
  try {
    const file = path.join(directory, 'bad.wav');
    await writeFile(file, 'not a wave file');
    await assert.rejects(validateWave(file), /playable WAV/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('native engine produces playable audio and removes its plaintext input', {
  skip: process.env.RUN_NATIVE_SPEECH !== '1' ? 'Set RUN_NATIVE_SPEECH=1 on a desktop with a speech engine installed.' : false
}, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'clear-reader-native-'));
  try {
    const speech = await NativeSpeech.create(path.resolve('scripts/speak.ps1'));
    const voices = await speech.voices();
    assert.ok(voices.length > 0);
    const file = path.join(directory, 'sample.wav');
    await speech.synthesize('Row one. Service: Mail. State: Ready.', voices[0]!.id, file);
    await validateWave(file);
    assert.ok((await readFile(file)).length > 1000);
    await assert.rejects(readFile(`${file}.txt`), { code: 'ENOENT' });
    await speech.synthesize('The system default voice also works.', '', file);
    await validateWave(file);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
