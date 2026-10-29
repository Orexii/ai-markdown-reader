import * as vscode from 'vscode';
import * as path from 'node:path';
import { Reader, type Start } from './reader';
import { Services } from './services';
import { MODELS, VOICES } from './model';
import { PlayerView } from './view';
import { EditorHighlight } from './highlight';
import { Controls } from './controls';
import { DescribeLens } from './lens';
import { PreviewPanels } from './previewPanel';
import { formatSpeed, speedChoices } from './speeds';

const TRANSPORT = ['togglePlay', 'play', 'pause', 'skipBack', 'skipForward', 'previousSentence', 'nextSentence', 'previousParagraph', 'nextParagraph',
  'previousSection', 'nextSection', 'faster', 'slower'];
/** VS Code's own Markdown preview: the "Markdown Preview" editor type, and the Open Preview panel. */
const BUILT_IN_PREVIEW_EDITOR = 'vscode.markdown.preview.editor';
const isBuiltInPreviewPanel = (viewType: string) => viewType === 'markdown.preview' || viewType.endsWith('-markdown.preview');

/** The Markdown being looked at: a text editor, VS Code's preview, or the Read Aloud Preview. */
interface Target {
  document: vscode.TextDocument;
  editor?: vscode.TextEditor;
  /** The tab of VS Code's own preview, which Read Aloud swaps for its preview. */
  builtInPreview?: vscode.Tab;
}

export function activate(context: vscode.ExtensionContext): void {
  const services = new Services(context);
  const view = new PlayerView(context.extensionUri, () => services.settings());
  const highlight = new EditorHighlight();
  const controls = new Controls();
  const previews = new PreviewPanels(context.extensionUri, message => services.output.appendLine(message));
  const reader = new Reader(services, view, highlight, controls, previews);
  const lens = new DescribeLens(reader);
  context.subscriptions.push(
    services, view, highlight, controls, lens, reader, previews,
    vscode.window.registerWebviewViewProvider(PlayerView.id, view, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.window.registerCustomEditorProvider(PreviewPanels.viewType, previews, {
      webviewOptions: { retainContextWhenHidden: true }, supportsMultipleEditorsPerDocument: true
    }),
    vscode.languages.registerCodeLensProvider({ language: 'markdown' }, lens)
  );

  const report = (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    services.output.appendLine(message);
    void vscode.window.showErrorMessage(`AI Markdown Reader: ${message}`);
  };
  // The Open Preview panel does not say which file it shows; its title and the last Markdown editor do.
  let lastMarkdown: vscode.Uri | undefined = vscode.window.activeTextEditor?.document.languageId === 'markdown' ? vscode.window.activeTextEditor.document.uri : undefined;
  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(editor => {
    if (editor?.document.languageId === 'markdown') lastMarkdown = editor.document.uri;
  }));
  const previewSource = (tab: vscode.Tab): vscode.TextDocument | undefined => {
    const name = tab.label.replace(/^(\[Preview\]|Preview)\s+/, '');
    const candidates = vscode.workspace.textDocuments.filter(document => document.languageId === 'markdown' && path.posix.basename(document.uri.path) === name);
    return candidates.find(document => document.uri.toString() === lastMarkdown?.toString()) ?? candidates[0];
  };
  /** The file a tab shows, in a text editor or a custom editor such as a preview. */
  const fileOf = (tab: vscode.Tab | undefined): vscode.Uri | undefined =>
    tab?.input instanceof vscode.TabInputText || tab?.input instanceof vscode.TabInputCustom ? tab.input.uri : undefined;
  /** The tab on screen showing a file, in the focused group first. */
  const tabShowing = (uri: vscode.Uri): vscode.Tab | undefined => {
    const { activeTabGroup, all } = vscode.window.tabGroups;
    return [activeTabGroup, ...all].map(group => group.activeTab).find(tab => fileOf(tab)?.toString() === uri.toString());
  };
  /** The Markdown in a tab, or by default in the active editor or tab. */
  const target = async (tab?: vscode.Tab): Promise<Target> => {
    const active = vscode.window.activeTextEditor;
    if (!tab && active?.document.languageId === 'markdown') return { document: active.document, editor: active };
    const shown = tab ?? vscode.window.tabGroups.activeTabGroup.activeTab;
    const input = shown?.input;
    if (shown && input instanceof vscode.TabInputText) {
      const editor = vscode.window.visibleTextEditors.find(candidate =>
        candidate.document.uri.toString() === input.uri.toString() && candidate.viewColumn === shown.group.viewColumn);
      if (editor?.document.languageId === 'markdown') return { document: editor.document, editor };
    }
    if (shown && input instanceof vscode.TabInputCustom && (input.viewType === PreviewPanels.viewType || input.viewType === BUILT_IN_PREVIEW_EDITOR)) {
      const document = await vscode.workspace.openTextDocument(input.uri);
      return { document, builtInPreview: input.viewType === BUILT_IN_PREVIEW_EDITOR ? shown : undefined };
    }
    if (shown && input instanceof vscode.TabInputWebview && isBuiltInPreviewPanel(input.viewType)) {
      const document = previewSource(shown);
      if (!document) throw new Error('Could not tell which file this preview shows. Open the Markdown file and try again.');
      return { document, builtInPreview: shown };
    }
    if (tab) throw new Error('Choose a Markdown file.');
    const visible = vscode.window.visibleTextEditors.find(editor => editor.document.languageId === 'markdown');
    if (visible) return { document: visible.document, editor: visible };
    throw new Error('Open a Markdown file or its preview first.');
  };
  /** VS Code's preview cannot show the reading position, so show the Read Aloud Preview in its place. */
  const swapPreview = async (tab: vscode.Tab, document: vscode.TextDocument): Promise<void> => {
    if (!services.settings().replaceMarkdownPreview) return;
    await vscode.commands.executeCommand('vscode.openWith', document.uri, PreviewPanels.viewType, { viewColumn: tab.group.viewColumn, preview: false });
    const stale = vscode.window.tabGroups.all.flatMap(group => group.tabs).find(candidate => candidate.group.viewColumn === tab.group.viewColumn && candidate.label === tab.label &&
      (candidate.input instanceof vscode.TabInputCustom ? candidate.input.viewType === BUILT_IN_PREVIEW_EDITOR : candidate.input instanceof vscode.TabInputWebview && isBuiltInPreviewPanel(candidate.input.viewType)));
    if (stale) await vscode.window.tabGroups.close(stale, true);
  };
  const open = (start: Start | 'cursor', selection = false) => async (resource?: unknown) => {
    const where = (editor?: vscode.TextEditor): Start => (start !== 'cursor' ? start
      : editor ? { line: editor.selection.active.line, character: editor.selection.active.character } : 'resume');
    try {
      // The Explorer passes the file clicked. An editor's title bar passes the file it shows, or a
      // webview-panel: address for VS Code's Open Preview panel, so a file on screen is read where it is,
      // even in a preview.
      const file = resource instanceof vscode.Uri && resource.scheme !== 'webview-panel' ? resource : undefined;
      const shown = file && tabShowing(file);
      if (file && !shown) {
        // Not on screen: show the file, because the reading is highlighted in its editor.
        const document = await vscode.workspace.openTextDocument(file);
        if (document.languageId !== 'markdown') throw new Error('Choose a Markdown file.');
        await vscode.window.showTextDocument(document, { preview: true });
        await reader.open({ document, start: 'resume' });
        return;
      }
      const found = await target(shown);
      if (!found.editor) {
        if (selection) throw new Error('Select the Markdown you want to hear in the editor first.');
        if (found.builtInPreview) await swapPreview(found.builtInPreview, found.document);
        await reader.open({ document: found.document, start: where() });
        return;
      }
      const editor = found.editor;
      if (selection && editor.selection.isEmpty) throw new Error('Select the Markdown you want to hear first.');
      await reader.open({ document: editor.document, selection: selection ? editor.selection : undefined, start: where(editor) });
    } catch (error) {
      report(error);
    }
  };
  const register = (id: string, handler: (...args: never[]) => unknown) => context.subscriptions.push(vscode.commands.registerCommand(id, handler));

  register('aiMarkdownReader.read', open('resume'));
  register('aiMarkdownReader.readFromTop', open('top'));
  register('aiMarkdownReader.readFromCursor', open('cursor'));
  register('aiMarkdownReader.readSelection', open('top', true));
  for (const action of TRANSPORT) {
    register(`aiMarkdownReader.${action}`, () => {
      if (reader.active) reader.command(action);
      else if (action === 'togglePlay' || action === 'play') void open('resume')();
    });
  }
  const openPreview = (column: vscode.ViewColumn) => async (resource?: unknown) => {
    try {
      const uri = resource instanceof vscode.Uri ? resource : (await target()).document.uri;
      await vscode.commands.executeCommand('vscode.openWith', uri, PreviewPanels.viewType, { viewColumn: column, preview: false });
    } catch (error) {
      report(error);
    }
  };
  register('aiMarkdownReader.openPreview', openPreview(vscode.ViewColumn.Active));
  register('aiMarkdownReader.openPreviewToSide', openPreview(vscode.ViewColumn.Beside));
  register('aiMarkdownReader.readFromHere', () => previews.readFromContext());
  register('aiMarkdownReader.showSource', async () => {
    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    if (input instanceof vscode.TabInputCustom) await vscode.window.showTextDocument(input.uri, { viewColumn: vscode.ViewColumn.Beside });
  });
  context.subscriptions.push(previews.onDidRequestCommand(({ uri, action }) => {
    if (TRANSPORT.includes(action) && reader.isReading(uri)) reader.command(action);
  }));
  context.subscriptions.push(previews.onDidRequestRead(async ({ uri, line, character }) => {
    try {
      const document = await vscode.workspace.openTextDocument(uri);
      await reader.open({ document, start: { line, character } });
    } catch (error) {
      report(error);
    }
  }));
  register('aiMarkdownReader.stop', () => reader.stop());
  register('aiMarkdownReader.backToReading', () => reader.backToReading());
  register('aiMarkdownReader.showPlayer', () => view.reveal(false));
  register('aiMarkdownReader.refreshReading', () => {
    try {
      reader.refresh();
    } catch (error) {
      report(error);
    }
  });
  register('aiMarkdownReader.chooseSpeed', async () => {
    const expanded = services.settings().expandedSpeeds;
    type Item = vscode.QuickPickItem & { speed?: number; toggle?: boolean };
    const speeds: Item[] = speedChoices(expanded, reader.speed).map(speed => ({ label: formatSpeed(speed), description: speed === reader.speed ? 'current' : undefined, speed }));
    const pick = vscode.window.createQuickPick<Item>();
    pick.title = 'Reading speed';
    pick.placeholder = 'Pitch stays natural at every speed';
    pick.items = [...speeds, { label: '', kind: vscode.QuickPickItemKind.Separator },
      { label: expanded ? '$(fold) Fewer speeds' : '$(unfold) More speeds', description: expanded ? '0.5×, 1×, 1.5× and 2×' : '0.25× to 5× in quarter steps', toggle: true }];
    pick.activeItems = speeds.filter(item => item.speed === reader.speed);
    const picked = await new Promise<Item | undefined>(resolve => {
      pick.onDidAccept(() => resolve(pick.selectedItems[0]));
      pick.onDidHide(() => resolve(undefined));
      pick.show();
    });
    pick.dispose();
    if (picked?.toggle) {
      await services.update('expandedSpeeds', !expanded);
      await vscode.commands.executeCommand('aiMarkdownReader.chooseSpeed');
    } else if (picked?.speed !== undefined) reader.setRate(picked.speed);
  });
  register('aiMarkdownReader.chooseVoice', async () => {
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
  register('aiMarkdownReader.describeBlock', async (resource?: unknown, block?: unknown) => {
    try {
      let uri = resource instanceof vscode.Uri ? resource : undefined;
      let index = typeof block === 'number' ? block : undefined;
      if (!uri || index === undefined) {
        const editor = (await target()).editor;
        if (!editor) throw new Error('Put the cursor in a table or code block in the editor, or use the link above it.');
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
  register('aiMarkdownReader.restoreBlock', (resource?: unknown, block?: unknown) => {
    if (resource instanceof vscode.Uri && typeof block === 'number') reader.restore(resource, block);
  });
  register('aiMarkdownReader.installNaturalVoice', async () => {
    await services.migrated;
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
  register('aiMarkdownReader.removeNaturalVoice', async () => {
    const answer = await vscode.window.showWarningMessage('Remove the downloaded natural voice model from this computer?', { modal: true }, 'Remove');
    if (answer !== 'Remove') return;
    await reader.stop();
    services.stopNatural();
    await services.store.remove();
    void vscode.window.showInformationMessage('The natural voice model was removed. Read Aloud offers to download it again when needed.');
  });
  // Not contributed to the command palette: lets integration tests observe real playback and highlighting.
  register('aiMarkdownReader.testState', () => reader.snapshot());
}

export function deactivate(): void {
  // Everything is disposed through the extension context.
}
