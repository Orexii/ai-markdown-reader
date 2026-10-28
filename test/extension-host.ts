import * as assert from 'node:assert/strict';
import * as os from 'node:os';
import * as path from 'node:path';
import { writeFile } from 'node:fs/promises';
import * as vscode from 'vscode';

interface State { sessions: number; events: string[]; playing?: boolean; index?: number; total?: number; state?: string; kind?: string }

const state = () => vscode.commands.executeCommand<State>('clearMarkdown.testState');

async function until(check: (s: State) => boolean, label: string, timeout = 120_000): Promise<State> {
  const started = Date.now();
  let last: State | undefined;
  while (Date.now() - started < timeout) {
    last = await state();
    if (check(last)) return last;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${label}. Last state: ${JSON.stringify(last)}`);
}

async function closeReaders(): Promise<void> {
  const tabs = vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab => tab.input instanceof vscode.TabInputWebview);
  await vscode.window.tabGroups.close(tabs);
  await until(s => s.sessions === 0, 'readers to close', 10_000);
}

export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension('orexii.clear-markdown-reader');
  assert.ok(extension, 'extension is discoverable');
  await extension.activate();
  const file = path.join(os.tmpdir(), `clear-markdown-e2e-${Date.now()}.md`);
  const story = Array.from({ length: 10 }, (_, i) => `Sentence ${i + 1} keeps the reader busy for a few seconds so that hidden playback can be measured.`).join(' ');
  await writeFile(file, `# Integration test\n\nThe ANF team reads tables, row by row.\n\n- **First:** flowing prose.\n\n| Service | State |\n| --- | --- |\n| Mail | Ready |\n\n${story}\n`);
  const other = await vscode.workspace.openTextDocument({ language: 'plaintext', content: 'Covering the reader tab.' });
  const document = await vscode.workspace.openTextDocument(file);
  await vscode.window.showTextDocument(document);
  const config = vscode.workspace.getConfiguration('clearMarkdown');

  if (process.env.CMR_E2E_EXPECT_GESTURE === '1') {
    // A normal VS Code launch blocks webview sound until a click: the reader must ask for it clearly.
    await vscode.commands.executeCommand('clearMarkdown.read');
    const blocked = await until(s => s.events.includes('needs-gesture') || s.events.includes('playing'), 'the reader to request a click');
    assert.ok(blocked.events.includes('needs-gesture'), `Expected a Start listening prompt: ${blocked.events.join(' | ')}`);
    assert.ok(blocked.events.includes('audio'), 'natural audio was generated before the prompt');
    await closeReaders();
    console.log('Extension host: normal launch shows Start listening after generating natural audio.');
    return;
  }

  // Natural voice, using the model seeded into this profile's global storage by the harness. The
  // first playback needs one click in the webview; the harness clicks Start listening for real.
  await config.update('engine', 'natural', vscode.ConfigurationTarget.Global);
  await vscode.commands.executeCommand('clearMarkdown.read');
  let current = await until(s => s.events.includes('playing') || s.events.some(e => /error/.test(e)), 'natural voice playback in the webview');
  assert.ok(current.events.includes('playing'), `Webview did not play: ${current.events.join(' | ')}`);
  assert.equal(current.kind, 'natural');
  await until(s => s.playing === true, 'playing state');
  await vscode.commands.executeCommand('clearMarkdown.togglePlay');
  await until(s => s.playing === false, 'pause from the command');
  await vscode.commands.executeCommand('clearMarkdown.nextSentence');
  current = await until(s => (s.index ?? 0) > 0, 'next sentence command');
  await vscode.commands.executeCommand('clearMarkdown.togglePlay');
  await until(s => s.playing === true, 'resume without another click');

  // Hide the reader behind another tab in its group: playback should carry on in the background.
  const group = vscode.window.tabGroups.all.find(g => g.tabs.some(tab => tab.input instanceof vscode.TabInputWebview))!;
  await vscode.window.showTextDocument(other, { viewColumn: group.viewColumn, preserveFocus: true });
  const hiddenFrom = (await state()).index ?? 0;
  const hidden = await until(s => (s.index ?? 0) >= hiddenFrom + 2 || s.events.includes('finished'), 'progress while the reader is hidden', 60_000)
    .catch(error => ({ ...({} as State), events: [], error: String(error) } as State & { error?: string }));
  console.log(`Background: index ${hiddenFrom} -> ${hidden.index ?? '?'} while hidden${(hidden as { error?: string }).error ? ' (no progress)' : ''}.`);
  await vscode.commands.executeCommand('clearMarkdown.showReader');
  assert.ok(!(hidden as { error?: string }).error, 'reading continues while the reader tab is hidden');
  await until(s => s.events.includes('finished'), 'reaching the end of the document', 240_000);
  console.log(`Natural voice: played ${current.total} passages in the VS Code webview.`);

  // The reader panel is reused, so reading a selection plays immediately with no new click.
  const editor = await vscode.window.showTextDocument(document);
  editor.selection = new vscode.Selection(new vscode.Position(4, 0), new vscode.Position(4, 30));
  await vscode.commands.executeCommand('clearMarkdown.readSelection');
  current = await until(s => s.total === 1 && (s.events.includes('playing') || s.events.includes('needs-gesture')), 'selection playback');
  assert.ok(!current.events.includes('needs-gesture'), 'a reused reader must not ask for another click');
  assert.equal(current.sessions, 1);

  // Changing the engine setting applies live; the next read uses system voices.
  await config.update('engine', 'system', vscode.ConfigurationTarget.Global);
  await vscode.window.showTextDocument(document);
  await vscode.commands.executeCommand('clearMarkdown.readFromTop');
  current = await until(s => s.kind === 'system' && (s.events.includes('playing') || s.events.includes('needs-gesture')), 'system voice playback');
  assert.ok(current.events.includes('playing'), `System voice did not play: ${current.events.join(' | ')}`);
  await closeReaders();
  await config.update('engine', undefined, vscode.ConfigurationTarget.Global);
  console.log('Extension host: natural voice, commands, selection and system voice playback passed.');
}
