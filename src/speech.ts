import { spawn } from 'node:child_process';
import { access, readFile, rm, writeFile } from 'node:fs/promises';
import * as path from 'node:path';

export interface Voice { id: string; label: string }
type Engine = 'windows' | 'mac' | 'espeak-ng' | 'espeak';
export interface ProcessResult { stdout: string; stderr: string }

export function runProcess(command: string, args: string[], signal?: AbortSignal): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], signal });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let processError: Error | undefined;
    const timeout = setTimeout(() => { timedOut = true; child.kill(); }, 120_000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (data: string) => { stdout += data; });
    child.stderr.on('data', (data: string) => { stderr += data; });
    child.on('error', error => { processError = error; });
    child.on('close', code => {
      clearTimeout(timeout);
      if (processError) reject(processError);
      else if (signal?.aborted) reject(new Error('Speech generation cancelled.'));
      else if (timedOut) reject(new Error(`${command} timed out generating speech.`));
      else if (code !== 0) reject(new Error(`${command} exited with code ${code}: ${stderr.trim() || stdout.trim()}`));
      else resolve({ stdout, stderr });
    });
  });
}

function unavailableEngine(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'EACCES');
}

export class NativeSpeech {
  private constructor(private readonly engine: Engine, private readonly script: string) {}

  static async create(script: string): Promise<NativeSpeech> {
    if (process.platform === 'win32') return new NativeSpeech('windows', script);
    if (process.platform === 'darwin') return new NativeSpeech('mac', script);
    if (process.platform !== 'linux') throw new Error(`Unsupported desktop platform: ${process.platform}.`);
    const failures: string[] = [];
    for (const engine of ['espeak-ng', 'espeak'] as const) {
      try {
        await runProcess(engine, ['--version']);
        return new NativeSpeech(engine, script);
      } catch (error) {
        if (!unavailableEngine(error)) throw error;
        failures.push(error instanceof Error ? error.message : String(error));
      }
    }
    throw new Error(`No usable local speech engine found. On Linux install espeak-ng (for example: sudo apt install espeak-ng), then reopen the reader. Audio uses the desktop machine, not a remote/WSL workspace. Engine diagnostics: ${failures.join('; ')}`);
  }

  async voices(): Promise<Voice[]> {
    if (this.engine === 'windows') {
      const { stdout } = await runProcess('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', this.script, '-ListVoices'
      ]);
      const parsed: unknown = JSON.parse(stdout.replace(/^\uFEFF/, ''));
      if (!Array.isArray(parsed) || !parsed.every((voice: unknown): voice is Voice =>
        typeof voice === 'object' && voice !== null &&
        'id' in voice && typeof voice.id === 'string' &&
        'label' in voice && typeof voice.label === 'string')) {
        throw new Error('Windows returned an invalid voice list.');
      }
      return parsed;
    }
    if (this.engine === 'mac') {
      const { stdout } = await runProcess('/usr/bin/say', ['-v', '?']);
      return stdout.split(/\r?\n/).flatMap(line => {
        const match = line.match(/^(.+?)\s+([a-z]{2,3}[_-][A-Z]{2})\s+#/);
        return match ? [{ id: match[1]!.trim(), label: `${match[1]!.trim()} (${match[2]})` }] : [];
      });
    }
    const { stdout } = await runProcess(this.engine, ['--voices']);
    return stdout.split(/\r?\n/).slice(1).flatMap(line => {
      const fields = line.trim().split(/\s+/);
      if (fields.length < 5) return [];
      return [{ id: fields[4]!, label: `${fields[3]!.replace(/_/g, ' ')} (${fields[1]})` }];
    });
  }

  async synthesize(text: string, voice: string, output: string, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new Error('Speech generation cancelled.');
    const input = `${output}.txt`;
    await writeFile(input, text, 'utf8');
    try {
      if (this.engine === 'windows') {
        await runProcess('powershell.exe', [
          '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', this.script,
          '-TextPath', input, '-OutputPath', output, ...(voice ? ['-Voice', voice] : [])
        ], signal);
      } else if (this.engine === 'mac') {
        await runProcess('/usr/bin/say', [
          ...(voice ? ['-v', voice] : []),
          '-f', input, '-o', output, '--file-format=WAVE', '--data-format=LEI16@22050'
        ], signal);
      } else {
        await runProcess(this.engine, [
          ...(voice ? ['-v', voice] : []), '-f', input, '-w', output
        ], signal);
      }
      await validateWave(output);
    } finally {
      await rm(input, { force: true });
    }
  }
}

export async function validateWave(file: string): Promise<void> {
  await access(path.resolve(file));
  const buffer = await readFile(file);
  if (buffer.length <= 44 || buffer.toString('ascii', 0, 4) !== 'RIFF' ||
      buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('The system speech engine did not generate a playable WAV file.');
  }
}
