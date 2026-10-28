import * as vscode from 'vscode';
import { ReaderSession, type Start } from './reader';
import { Services } from './services';
import { MODELS } from './model';

const TRANSPORT = ['togglePlay', 'skipBack', 'skipForward', 'previousSentence', 'nextSentence', 'previousParagraph', 'nextParagraph', 'faster', 'slower', 'stop'];

export function activate(context: vscode.ExtensionContext): void {
  const services = new Services(context);
  context.subscriptions.push(services);
  const report = (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    services.output.appendLine(message);
    void vscode.window.showErrorMessage(`Clear Markdown Reader: ${message}`);
  };
  const markdownEditor = () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== 'markdown') throw new Error('Open a Markdown file in the editor first.');
    return editor;
  };
  const open = (start: (editor: vscode.TextEditor) => Start, selection = false) => async (resource?: unknown) => {
    try {
      // The Explorer context menu passes the clicked file; otherwise read the active editor.
      const active = vscode.window.activeTextEditor;
      if (resource instanceof vscode.Uri && resource.toString() !== active?.document.uri.toString()) {
        const document = await vscode.workspace.openTextDocument(resource);
        if (document.languageId !== 'markdown') throw new Error('Choose a Markdown file.');
        ReaderSession.open(services, { document, start: 'resume', autoplay: true });
        return;
      }
      const editor = markdownEditor();
      if (selection && editor.selection.isEmpty) throw new Error('Select the Markdown you want to hear first.');
      ReaderSession.open(services, { document: editor.document, selection: selection ? editor.selection : undefined, start: start(editor), autoplay: true });
    } catch (error) {
      report(error);
    }
  };
  context.subscriptions.push(
    vscode.commands.registerCommand('clearMarkdown.read', open(() => 'resume')),
    vscode.commands.registerCommand('clearMarkdown.readFromTop', open(() => 'top')),
    vscode.commands.registerCommand('clearMarkdown.readFromCursor', open(editor => ({ line: editor.selection.active.line }))),
    vscode.commands.registerCommand('clearMarkdown.readSelection', open(() => 'top', true)),
    ...TRANSPORT.map(action => vscode.commands.registerCommand(`clearMarkdown.${action}`, () => {
      const session = ReaderSession.active;
      if (session) session.command(action);
      else if (action === 'togglePlay') void open(editor => ({ line: editor.selection.active.line }))();
    })),
    vscode.commands.registerCommand('clearMarkdown.showReader', () => ReaderSession.active?.show()),
    vscode.commands.registerCommand('clearMarkdown.installNaturalVoice', async () => {
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
    }),
    vscode.commands.registerCommand('clearMarkdown.removeNaturalVoice', async () => {
      const answer = await vscode.window.showWarningMessage('Remove the downloaded natural voice model from this computer?', { modal: true }, 'Remove');
      if (answer !== 'Remove') return;
      for (const session of [...ReaderSession.sessions]) session.dispose();
      services.stopNatural();
      await services.store.remove();
      void vscode.window.showInformationMessage('The natural voice model was removed. Read Aloud offers to download it again when needed.');
    }),
    // Not contributed to the command palette: lets integration tests observe real webview playback.
    vscode.commands.registerCommand('clearMarkdown.testState', () => ({
      sessions: ReaderSession.sessions.size,
      ...(ReaderSession.active?.snapshot() ?? { events: [] })
    }))
  );
}

export function deactivate(): void {
  for (const session of [...ReaderSession.sessions]) session.dispose();
}
