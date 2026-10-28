import * as vscode from 'vscode';
import { Reader, type Start } from './reader';
import { Services } from './services';
import { MODELS, VOICES } from './model';
import { PlayerView } from './view';
import { EditorHighlight } from './highlight';
import { Controls } from './controls';
import { DescribeLens } from './lens';
import { SPEEDS, formatSpeed } from './markup';

const TRANSPORT = ['togglePlay', 'play', 'pause', 'skipBack', 'skipForward', 'previousSentence', 'nextSentence', 'previousParagraph', 'nextParagraph', 'faster', 'slower'];

export function activate(context: vscode.ExtensionContext): void {
  const services = new Services(context);
  const view = new PlayerView(context.extensionUri, () => services.settings());
  const highlight = new EditorHighlight();
  const controls = new Controls();
  const reader = new Reader(services, view, highlight, controls);
  const lens = new DescribeLens(reader);
  context.subscriptions.push(
    services, view, highlight, controls, lens, reader,
    vscode.window.registerWebviewViewProvider(PlayerView.id, view, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.languages.registerCodeLensProvider({ language: 'markdown' }, lens)
  );

  const report = (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    services.output.appendLine(message);
    void vscode.window.showErrorMessage(`Clear Markdown Reader: ${message}`);
  };
  const markdownEditor = (): vscode.TextEditor => {
    const active = vscode.window.activeTextEditor;
    if (active?.document.languageId === 'markdown') return active;
    const visible = vscode.window.visibleTextEditors.find(editor => editor.document.languageId === 'markdown');
    if (visible) return visible;
    throw new Error('Open a Markdown file in the editor first.');
  };
  const open = (start: (editor: vscode.TextEditor) => Start, selection = false) => async (resource?: unknown) => {
    try {
      if (resource instanceof vscode.Uri && resource.toString() !== vscode.window.activeTextEditor?.document.uri.toString()) {
        // From the Explorer: show the file, because the reading is highlighted in its editor.
        const document = await vscode.workspace.openTextDocument(resource);
        if (document.languageId !== 'markdown') throw new Error('Choose a Markdown file.');
        await vscode.window.showTextDocument(document, { preview: true });
        await reader.open({ document, start: 'resume' });
        return;
      }
      const editor = markdownEditor();
      if (selection && editor.selection.isEmpty) throw new Error('Select the Markdown you want to hear first.');
      await reader.open({ document: editor.document, selection: selection ? editor.selection : undefined, start: start(editor) });
    } catch (error) {
      report(error);
    }
  };
  const cursor = (editor: vscode.TextEditor): Start => ({ line: editor.selection.active.line, character: editor.selection.active.character });
  const register = (id: string, handler: (...args: never[]) => unknown) => context.subscriptions.push(vscode.commands.registerCommand(id, handler));

  register('clearMarkdown.read', open(() => 'resume'));
  register('clearMarkdown.readFromTop', open(() => 'top'));
  register('clearMarkdown.readFromCursor', open(cursor));
  register('clearMarkdown.readSelection', open(() => 'top', true));
  for (const action of TRANSPORT) {
    register(`clearMarkdown.${action}`, () => {
      if (reader.active) reader.command(action);
      else if (action === 'togglePlay' || action === 'play') void open(() => 'resume')();
    });
  }
  register('clearMarkdown.stop', () => reader.stop());
  register('clearMarkdown.backToReading', () => reader.backToReading());
  register('clearMarkdown.showPlayer', () => view.reveal(false));
  register('clearMarkdown.refreshReading', () => {
    try {
      reader.refresh();
    } catch (error) {
      report(error);
    }
  });
  register('clearMarkdown.chooseSpeed', async () => {
    const items = SPEEDS.map(speed => ({ label: formatSpeed(speed), description: speed === reader.speed ? 'current' : undefined, speed }));
    const picked = await vscode.window.showQuickPick(items, { title: 'Reading speed', placeHolder: 'Pitch stays natural at every speed' });
    if (picked) reader.setRate(picked.speed);
  });
  register('clearMarkdown.chooseVoice', async () => {
    try {
      const settings = services.settings();
      const choices = reader.voiceChoices();
      const natural = (reader.active ? choices.kind : settings.engine) === 'natural';
      const voices = natural
        ? VOICES.map(v => ({ id: v.id, label: v.name, description: `${v.accent} ${v.gender.toLowerCase()} · grade ${v.grade}` }))
        : [{ id: '', label: 'System default voice', description: '' }, ...(await services.systemEngine()).voices.map(v => ({ id: v.id, label: v.label, description: '' }))];
      const current = reader.active ? choices.voice : natural ? settings.naturalVoice : settings.systemVoice;
      const picked = await vscode.window.showQuickPick(voices.map(v => ({ ...v, label: v.id === current ? `$(check) ${v.label}` : v.label })), {
        title: natural ? 'Natural voice' : 'System voice', matchOnDescription: true
      });
      if (!picked) return;
      if (reader.active) await reader.changeVoice(picked.id);
      else await services.update(natural ? 'naturalVoice' : 'systemVoice', picked.id);
    } catch (error) {
      report(error);
    }
  });
  register('clearMarkdown.describeBlock', async (resource?: unknown, block?: unknown) => {
    try {
      let uri = resource instanceof vscode.Uri ? resource : undefined;
      let index = typeof block === 'number' ? block : undefined;
      if (!uri || index === undefined) {
        const editor = markdownEditor();
        uri = editor.document.uri;
        if (!reader.isReading(uri)) throw new Error('Start reading this file, then put the cursor in a table or code block.');
        index = reader.blockAt(uri, editor.selection.active.line);
        if (index === undefined) throw new Error('Put the cursor in a table or code block of the file being read.');
      }
      await reader.describe(uri, index);
    } catch (error) {
      report(error);
    }
  });
  register('clearMarkdown.restoreBlock', (resource?: unknown, block?: unknown) => {
    if (resource instanceof vscode.Uri && typeof block === 'number') reader.restore(resource, block);
  });
  register('clearMarkdown.installNaturalVoice', async () => {
    const settings = services.settings();
    const size = Math.round(MODELS[settings.quality].size / 1e6);
    try {
      await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification, title: `Downloading the natural voice (${size} MB)`, cancellable: true
      }, async (progress, token) => {
        const controller = new AbortController();
        token.onCancellationRequested(() => controller.abort());
        let reported = 0;
        await services.store.install(settings.quality, settings.naturalVoice, (received, total) => {
          const percent = Math.floor((received / total) * 100);
          if (percent > reported) {
            progress.report({ increment: percent - reported, message: `${percent}%` });
            reported = percent;
          }
        }, controller.signal);
      });
      await services.update('engine', 'natural');
      void vscode.window.showInformationMessage('The natural voice is installed. It runs on this computer.');
    } catch (error) {
      report(error);
    }
  });
  register('clearMarkdown.removeNaturalVoice', async () => {
    const answer = await vscode.window.showWarningMessage('Remove the downloaded natural voice model from this computer?', { modal: true }, 'Remove');
    if (answer !== 'Remove') return;
    await reader.stop();
    services.stopNatural();
    await services.store.remove();
    void vscode.window.showInformationMessage('The natural voice model was removed. Read Aloud offers to download it again when needed.');
  });
  // Not contributed to the command palette: lets integration tests observe real playback and highlighting.
  register('clearMarkdown.testState', () => reader.snapshot());
}

export function deactivate(): void {
  // Everything is disposed through the extension context.
}
