import * as assert from 'node:assert/strict';
import * as os from 'node:os';
import * as path from 'node:path';
import { writeFile } from 'node:fs/promises';
import * as vscode from 'vscode';

interface State {
  loaded: boolean;
  file?: string;
  events: string[];
  playing: boolean;
  waiting: boolean;
  index: number;
  word: number;
  total: number;
  state: string;
  kind: string;
  rate: number;
  viewVisible: boolean;
  detached: false | 'above' | 'below';
  sentenceText?: string;
  wordText?: string;
  expectedWord?: string;
  editors: number;
  stale: boolean;
  volume: number;
  muted: boolean;
  previews: number;
  previewSentence?: string;
  previewWord?: string;
}

const state = () => vscode.commands.executeCommand<State>('aiMarkdownReader.testState');

async function until(check: (s: State) => boolean, label: string, timeout = 120_000): Promise<State> {
  const started = Date.now();
  let last: State | undefined;
  while (Date.now() - started < timeout) {
    last = await state();
    if (check(last)) return last;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${label}. Last state: ${JSON.stringify(last)}`);
}

const stats = (events: string[], prefix: string) => events.filter(e => e.startsWith(prefix)).map(e => Number(e.slice(prefix.length)));

export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension('orexii.ai-markdown-reader');
  assert.ok(extension, 'extension is discoverable');
  await extension.activate();
  const file = path.join(os.tmpdir(), `ai-markdown-reader-e2e-${Date.now()}.md`);
  const story = Array.from({ length: 14 }, (_, i) => `Sentence ${i + 1} keeps the reader busy for a few seconds so that playback can be measured.`).join(' ');
  const text = `# Integration test\n\nThe ANF team reads tables, row by row.\n\n- **First:** flowing prose.\n\n| Service | State |\n| --- | --- |\n| Mail | Ready |\n| Chat | Busy |\n\n${story}\n`;
  await writeFile(file, text);
  const document = await vscode.workspace.openTextDocument(file);
  const editor = await vscode.window.showTextDocument(document);
  const config = vscode.workspace.getConfiguration('aiMarkdownReader');

  if (process.env.CMR_E2E_EXPECT_GESTURE === '1') {
    // A normal VS Code launch blocks webview sound until a click: the player must show itself and ask.
    await vscode.commands.executeCommand('aiMarkdownReader.read');
    const blocked = await until(s => s.events.includes('needs-gesture') || s.events.includes('playing'), 'the player to request a click');
    assert.ok(blocked.events.includes('needs-gesture'), `Expected a Start prompt: ${blocked.events.join(' | ')}`);
    assert.ok(blocked.events.includes('audio'), 'natural audio was generated before the prompt');
    assert.ok(blocked.viewVisible, 'the player view is shown so the listener can click Start');
    assert.ok(blocked.sentenceText, 'the first sentence is already highlighted in the editor');
    await vscode.commands.executeCommand('aiMarkdownReader.stop');
    console.log('Extension host: a normal launch shows the player with Start after generating natural audio.');
    return;
  }

  // Natural voice, using the model the harness seeded where the old extension (Clear Markdown Reader) kept
  // it, with old settings: both must move over. The first playback needs one click in the player; the
  // harness clicks Start for real when asked.
  const settled = async (check: () => boolean, label: string) => {
    for (let tries = 0; tries < 100 && !check(); tries++) await new Promise(resolve => setTimeout(resolve, 100));
    assert.ok(check(), label);
  };
  await settled(() => vscode.workspace.getConfiguration('aiMarkdownReader').get('volume') === 90, 'the volume set under the old name moved over');
  await settled(() => vscode.workspace.getConfiguration('clearMarkdown').inspect('volume')?.globalValue === undefined, 'the old setting was removed');
  await config.update('volume', undefined, vscode.ConfigurationTarget.Global);
  await config.update('engine', 'natural', vscode.ConfigurationTarget.Global);
  await vscode.commands.executeCommand('aiMarkdownReader.read');
  let current = await until(s => s.events.includes('playing') || s.events.some(e => /error/.test(e)) || s.state === 'missing', 'natural voice playback');
  assert.notEqual(current.state, 'missing', 'the voice downloaded under the old name was moved, not downloaded again');
  assert.ok(current.events.includes('playing'), `Player did not play: ${current.events.join(' | ')}`);
  assert.equal(current.kind, 'natural');
  assert.equal(current.file, path.basename(file));

  // The editor shows the sentence and the exact word being spoken.
  current = await until(s => !!s.wordText && !!s.expectedWord, 'a highlighted word');
  assert.ok(current.sentenceText && current.sentenceText.length > 3, 'sentence highlighted');
  assert.equal(current.wordText!.replace(/[*_`]/g, ''), current.expectedWord, 'the highlighted word is the one being spoken');
  assert.ok(text.includes(current.sentenceText!), 'the highlight covers real document text');

  await vscode.commands.executeCommand('aiMarkdownReader.togglePlay');
  await until(s => !s.playing, 'pause from the command');
  const paused = (await state()).index;
  await vscode.commands.executeCommand('aiMarkdownReader.nextSentence');
  await until(s => s.index === paused + 1, 'next sentence command');
  await vscode.commands.executeCommand('aiMarkdownReader.togglePlay');
  await until(s => s.playing, 'resume without another click');

  // A volume changed in the Settings editor reaches the playing player.
  await config.update('volume', 40, vscode.ConfigurationTarget.Global);
  await until(s => s.volume === 40 && !s.muted, 'the volume setting to reach the player', 10_000);
  await config.update('volume', undefined, vscode.ConfigurationTarget.Global);
  await until(s => s.volume === 100, 'the default volume', 10_000);

  // Read from the cursor in the table: the reading moves there without rebuilding.
  editor.selection = new vscode.Selection(new vscode.Position(8, 9), new vscode.Position(8, 9));
  await vscode.commands.executeCommand('aiMarkdownReader.readFromCursor');
  current = await until(s => s.sentenceText === '| Mail | Ready |', 'reading the table row at the cursor');
  // Next paragraph in a table moves one row, not past the whole table.
  await vscode.commands.executeCommand('aiMarkdownReader.nextParagraph');
  current = await until(s => s.sentenceText === '| Chat | Busy |', 'next paragraph to move to the next table row');

  // Editing while listening keeps the highlight on the words being spoken.
  await editor.edit(edit => edit.insert(new vscode.Position(0, 0), 'Added while listening.\n\n'));
  current = await until(s => s.stale && s.index > current.index && !!s.wordText && !!s.expectedWord, 'reading on after an edit');
  assert.equal(current.wordText!.replace(/[*_`]/g, ''), current.expectedWord, 'highlights moved with the edit');
  await document.save();

  // Close the sidebar: the hidden player keeps playing while the editor follows along. The short speed list
  // stops at 2x; with More speeds on, it goes on in quarter steps.
  await vscode.commands.executeCommand('workbench.action.closeSidebar');
  for (let i = 0; i < 3; i++) await vscode.commands.executeCommand('aiMarkdownReader.faster');
  await until(s => s.rate === 2, 'the short speed list to stop at 2x');
  await new Promise(resolve => setTimeout(resolve, 1000));
  assert.equal((await state()).rate, 2, 'the short speed list has nothing above 2x');
  await config.update('expandedSpeeds', true, vscode.ConfigurationTarget.Global);
  const faster = async (target: number) => {
    for (let tries = 0; tries < 40 && (await state()).rate < target; tries++) {
      await vscode.commands.executeCommand('aiMarkdownReader.faster');
      await new Promise(resolve => setTimeout(resolve, 150));
    }
  };
  await faster(3);
  current = await until(s => s.rate === 3 && !s.viewVisible, 'triple speed with the player hidden');
  const hiddenFrom = current.index;
  await until(s => s.index >= hiddenFrom + 3, 'progress while the player is hidden', 60_000);
  current = await until(s => s.events.includes('finished'), 'reaching the end of the document', 240_000);
  const stalls = current.events.filter(e => /^stall \d+$/.test(e)).length;
  const gaps = stats(current.events, 'gap ');
  const late = current.events.filter(e => e === 'late-start').length;
  const sorted = [...gaps].sort((a, b) => a - b);
  console.log(`Natural voice: ${current.total} passages; ${stalls} stall(s); ${late} late start(s); ${gaps.length} track handoffs, ` +
    `gap median ${sorted[Math.floor(sorted.length / 2)] ?? 'n/a'} ms, max ${sorted.at(-1) ?? 'n/a'} ms.`);
  assert.ok(stalls <= 1, `playback stalled ${stalls} times at triple speed: ${current.events.join(' | ')}`);
  assert.ok(gaps.every(gap => gap < 250), `a track handoff left an audible gap: ${gaps.join(', ')}`);

  // The Read Aloud button in a preview's title bar reads in the preview, putting the Read Aloud Preview, which
  // highlights the spoken word, in place of VS Code's own previews. The harness clicks the button for real:
  // VS Code passes it the file the editor shows, which must not open the source instead.
  const isTab = (viewType: string) => (tab: vscode.Tab | undefined) => tab?.input instanceof vscode.TabInputCustom && tab.input.viewType === viewType;
  const isPreviewPanel = (tab: vscode.Tab | undefined) => tab?.input instanceof vscode.TabInputWebview && /markdown\.preview$/.test(tab.input.viewType);
  const allTabs = () => vscode.window.tabGroups.all.flatMap(group => group.tabs);
  const activeTab = () => vscode.window.tabGroups.activeTabGroup.activeTab;
  const letters = (value: string) => value.replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();
  let clicks = 0;
  const readFromTitleBar = async (where: string): Promise<State> => {
    await vscode.commands.executeCommand('aiMarkdownReader.stop');
    await until(s => !s.loaded, `stopping before reading from ${where}`);
    console.log(`E2E-CLICK title ${++clicks} [Read Aloud]`);
    const reading = await until(s => s.playing && !!s.previewWord && !!s.expectedWord && letters(s.previewWord) === letters(s.expectedWord),
      `the Read Aloud button in ${where} to read in the preview`, 60_000);
    assert.ok(isTab('aiMarkdownReader.preview')(activeTab()), `the Read Aloud Preview is showing after the Read Aloud button in ${where}`);
    assert.ok(reading.previewSentence!.includes(reading.previewWord!.replace(/[.,;:!?]+$/, '')), 'the spoken word is inside the highlighted sentence');
    return reading;
  };
  await vscode.commands.executeCommand('vscode.openWith', document.uri, 'vscode.markdown.preview.editor');
  await until(() => isTab('vscode.markdown.preview.editor')(activeTab()), "VS Code's Markdown Preview editor to open", 20_000);
  current = await readFromTitleBar("VS Code's Markdown Preview editor");
  assert.ok(!allTabs().some(isTab('vscode.markdown.preview.editor')), "VS Code's Markdown Preview editor was closed");
  console.log(`Read Aloud Preview: highlighted "${current.previewWord}" in "${current.previewSentence}".`);
  await readFromTitleBar('the Read Aloud Preview');
  await vscode.window.tabGroups.close(allTabs().filter(isTab('aiMarkdownReader.preview')));
  await vscode.window.showTextDocument(document);
  await vscode.commands.executeCommand('markdown.showPreview');
  await until(() => isPreviewPanel(activeTab()), "VS Code's Open Preview panel to open", 20_000);
  await readFromTitleBar("VS Code's Open Preview panel");
  assert.ok(!allTabs().some(isPreviewPanel), "VS Code's Open Preview panel was closed");
  await vscode.commands.executeCommand('aiMarkdownReader.togglePlay');
  await until(s => !s.playing, 'pause in the preview');
  await vscode.window.tabGroups.close(allTabs().filter(isTab('aiMarkdownReader.preview')));
  await config.update('rate', 1, vscode.ConfigurationTarget.Global);
  await until(s => s.rate === 1, 'normal speed');

  // The player is reused, so reading a selection plays at once with no new click.
  await vscode.window.showTextDocument(document);
  const selectionEditor = vscode.window.activeTextEditor!;
  selectionEditor.selection = new vscode.Selection(new vscode.Position(4, 0), new vscode.Position(4, 38));
  await vscode.commands.executeCommand('aiMarkdownReader.readSelection');
  current = await until(s => s.total === 1 && (s.events.includes('playing') || s.events.includes('needs-gesture')), 'selection playback');
  assert.ok(!current.events.includes('needs-gesture'), 'a reused player must not ask for another click');
  current = await until(s => !!s.sentenceText, 'selection highlight');
  assert.equal(current.sentenceText, 'The ANF team reads tables, row by row.');

  // Five times speed on a document whose audio has not been made yet: how well generation keeps up.
  const fast = path.join(os.tmpdir(), `ai-markdown-reader-e2e-fast-${Date.now()}.md`);
  const topics = ['Kusto clusters', 'Geneva logs', 'certificate rotation', 'regional rollouts', 'capacity planning', 'incident reviews'];
  await writeFile(fast, topics.map((topic, n) => `## ${topic}\n\n` + Array.from({ length: 5 }, (_, k) =>
    `Point ${k + 1} about ${topic} explains what the team checks before a change in section ${n + 1}, and why it matters.`).join(' ')).join('\n\n') + '\n');
  // Read Aloud from the Explorer on a file that is not open shows it in the editor, where the reading is highlighted.
  await config.update('rate', 5, vscode.ConfigurationTarget.Global);
  await vscode.commands.executeCommand('aiMarkdownReader.read', vscode.Uri.file(fast));
  current = await until(s => s.file === path.basename(fast) && s.rate === 5 && s.playing, 'five times speed on a new document');
  assert.equal(vscode.window.activeTextEditor?.document.uri.fsPath, vscode.Uri.file(fast).fsPath, 'a file read from the Explorer opens in the editor');
  const started = Date.now();
  current = await until(s => s.events.includes('finished'), 'finishing at five times speed', 240_000);
  const fastStalls = stats(current.events, 'stall-end ');
  console.log(`Natural voice at 5x: ${current.total} passages in ${((Date.now() - started) / 1000).toFixed(1)} s; ${fastStalls.length} stall(s)` +
    `${fastStalls.length ? `, longest ${Math.max(...fastStalls)} ms` : ''}.`);
  await config.update('rate', undefined, vscode.ConfigurationTarget.Global);
  await config.update('expandedSpeeds', undefined, vscode.ConfigurationTarget.Global);
  await vscode.window.showTextDocument(document);

  // Changing the engine setting applies live; the next document uses system voices.
  await config.update('engine', 'system', vscode.ConfigurationTarget.Global);
  await vscode.commands.executeCommand('aiMarkdownReader.readFromTop');
  current = await until(s => s.kind === 'system' && (s.events.includes('playing') || s.events.includes('needs-gesture')), 'system voice playback');
  assert.ok(current.events.includes('playing'), `System voice did not play: ${current.events.join(' | ')}`);
  await vscode.commands.executeCommand('aiMarkdownReader.stop');
  current = await until(s => !s.loaded, 'stop');
  assert.equal(current.sentenceText, undefined, 'stopping clears the highlight');
  await config.update('engine', undefined, vscode.ConfigurationTarget.Global);
  await config.update('rate', undefined, vscode.ConfigurationTarget.Global);
  console.log('Extension host: natural voice, editor highlighting, commands, short and expanded speeds, hidden player at 3x, Read Aloud button in all three previews, Explorer, selection, 5x and system voice passed.');
}
