import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, truncate, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { downloadVerified, migrateVoice, ModelStore, MODEL_FOLDER, MODELS, VOICES } from '../src/model';

const body = Buffer.from('natural voice model bytes '.repeat(4000));
const sha256 = createHash('sha256').update(body).digest('hex');

function fakeFetch(payload: Uint8Array, status = 200, chunk = 8192): typeof fetch & { calls: string[] } {
  const calls: string[] = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push(String(url));
    const signal = init?.signal;
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (signal?.aborted) return controller.error(new Error('aborted'));
        const offset = (this as unknown as { offset?: number }).offset ?? 0;
        if (offset >= payload.length) return controller.close();
        controller.enqueue(payload.subarray(offset, offset + chunk));
        (this as unknown as { offset: number }).offset = offset + chunk;
        await new Promise(resolve => setTimeout(resolve, 1));
      }
    });
    return new Response(status === 200 ? stream : null, { status, statusText: status === 200 ? 'OK' : 'Not Found' });
  }) as typeof fetch & { calls: string[] };
  fetcher.calls = calls;
  return fetcher;
}

async function temp(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), 'cmr-model-'));
}

test('verified downloads report progress and move into place atomically', async () => {
  const directory = await temp();
  try {
    const target = path.join(directory, 'nested', 'model.onnx');
    const progress: number[] = [];
    await downloadVerified('https://example.test/model', target, { size: body.length, sha256 }, received => progress.push(received), new AbortController().signal, fakeFetch(body));
    assert.deepEqual(await readFile(target), body);
    assert.equal(progress.at(-1), body.length);
    assert.deepEqual(await readdir(path.dirname(target)), ['model.onnx']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('corrupt, oversized, failed and cancelled downloads leave nothing behind', async () => {
  const directory = await temp();
  const target = path.join(directory, 'model.onnx');
  const signal = new AbortController().signal;
  try {
    await assert.rejects(downloadVerified('u', target, { size: body.length, sha256: '0'.repeat(64) }, () => undefined, signal, fakeFetch(body)), /failed verification/);
    await assert.rejects(downloadVerified('u', target, { size: 100, sha256 }, () => undefined, signal, fakeFetch(body)), /larger than expected/);
    await assert.rejects(downloadVerified('u', target, { size: body.length, sha256 }, () => undefined, signal, fakeFetch(body, 404)), /HTTP 404/);
    const controller = new AbortController();
    const pending = downloadVerified('u', target, { size: body.length, sha256 }, received => { if (received > 20000) controller.abort(); }, controller.signal, fakeFetch(body));
    await assert.rejects(pending, /cancelled/);
    assert.deepEqual(await readdir(directory), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('the store skips files that are present and shares concurrent installs', async () => {
  const directory = await temp();
  try {
    const failing = fakeFetch(body, 404);
    const store = new ModelStore(directory, failing);
    assert.equal(await store.hasModel('compact'), false);
    const first = store.install('compact', 'af_heart', () => undefined, new AbortController().signal);
    const second = store.install('compact', 'af_heart', () => undefined, new AbortController().signal);
    assert.equal(first, second);
    await assert.rejects(first, /HTTP 404/);
    assert.equal(failing.calls.length, 1);
    assert.match(failing.calls[0]!, /huggingface\.co\/onnx-community\/Kokoro-82M-v1\.0-ONNX-timestamped\/resolve\/[0-9a-f]{40}\/voices\/af_heart\.bin$/);

    await writeFile(store.modelPath('compact'), '');
    await truncate(store.modelPath('compact'), MODELS.compact.size);
    await mkdir(store.voicesDir, { recursive: true });
    await writeFile(path.join(store.voicesDir, 'af_heart.bin'), Buffer.alloc(522240));
    const unused = fakeFetch(body);
    await new ModelStore(directory, unused).install('compact', 'af_heart', () => undefined, new AbortController().signal);
    assert.equal(unused.calls.length, 0);
    assert.equal(await store.hasModel('compact'), true);
    assert.equal(await store.hasModel('best'), false);
    await store.remove();
    assert.equal(await store.hasVoice('af_heart'), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('pinned voices are unique, graded and well-formed', () => {
  assert.equal(new Set(VOICES.map(voice => voice.id)).size, 28);
  assert.equal(VOICES[0]!.id, 'af_heart');
  assert.ok(VOICES.every(voice => /^[0-9a-f]{64}$/.test(voice.sha256) && /^[ab][fm]_[a-z]+$/.test(voice.id)));
  assert.ok(Object.values(MODELS).every(model => /^[0-9a-f]{64}$/.test(model.sha256) && model.size > 1e7));
});

test('a voice downloaded under the old extension name is moved, never overwriting a newer download', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'amr-migrate-'));
  try {
    const legacy = path.join(root, 'orexii.clear-markdown-reader', MODEL_FOLDER);
    const current = path.join(root, 'orexii.ai-markdown-reader');
    const logs: string[] = [];
    assert.equal(await migrateVoice(current, message => logs.push(message)), false, 'nothing to move');
    await mkdir(path.join(legacy, 'voices'), { recursive: true });
    await writeFile(path.join(legacy, 'model.onnx'), 'model');
    await writeFile(path.join(legacy, 'voices', 'af_heart.bin'), 'voice');
    assert.equal(await migrateVoice(current, message => logs.push(message)), true);
    assert.equal(await readFile(path.join(current, MODEL_FOLDER, 'model.onnx'), 'utf8'), 'model');
    assert.equal(await readFile(path.join(current, MODEL_FOLDER, 'voices', 'af_heart.bin'), 'utf8'), 'voice');
    await assert.rejects(readFile(path.join(legacy, 'model.onnx')), 'moved, not copied');
    assert.match(logs.join(' '), /Moved the downloaded natural voice/);
    await mkdir(legacy, { recursive: true });
    await writeFile(path.join(legacy, 'model.onnx'), 'older');
    assert.equal(await migrateVoice(current, () => undefined), false, 'an existing download wins');
    assert.equal(await readFile(path.join(current, MODEL_FOLDER, 'model.onnx'), 'utf8'), 'model');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
