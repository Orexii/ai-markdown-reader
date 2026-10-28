import * as ort from 'onnxruntime-node';
import { phonemize } from 'phonemizer';
import { KokoroModel, SAMPLE_RATE, TooLongError, type SynthesisRequest } from './kokoro';
import { encodeWav } from './wav';

interface Message {
  id: number;
  type: 'load' | 'synthesize' | 'shutdown';
  modelPath?: string;
  voicesDir?: string;
  lexiconDir?: string;
  threads?: number;
  request?: SynthesisRequest;
}

let model: KokoroModel | undefined;
let queue: Promise<void> = Promise.resolve();
ort.env.logLevel = 'error';

function reply(message: object): void {
  process.send?.(message);
}

async function handle(message: Message): Promise<void> {
  try {
    if (message.type === 'shutdown') {
      process.exit(0);
    } else if (message.type === 'load') {
      model = await KokoroModel.load({
        ort: ort as never, modelPath: message.modelPath!, voicesDir: message.voicesDir!, lexiconDir: message.lexiconDir, threads: message.threads ?? 4, phonemize
      });
      reply({ id: message.id, type: 'ok' });
    } else if (message.type === 'synthesize') {
      if (!model) throw new Error('The natural voice model is not loaded.');
      const segments = await model.synthesize(message.request!);
      reply({
        id: message.id, type: 'ok',
        segments: segments.map(segment => ({ wav: encodeWav(segment.samples, SAMPLE_RATE), duration: segment.duration, wordTimes: segment.wordTimes }))
      });
    }
  } catch (error) {
    reply({ id: message.id, type: 'error', message: error instanceof Error ? error.message : String(error), tooLong: error instanceof TooLongError });
  }
}

process.on('message', (message: Message) => {
  queue = queue.then(() => handle(message));
});
process.on('disconnect', () => process.exit(0));
