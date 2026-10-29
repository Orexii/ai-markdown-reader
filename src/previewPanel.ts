import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import type { SourceRange } from './document';
import { renderPreview } from './preview';

interface Panel {
  panel: vscode.WebviewPanel;
  document: vscode.TextDocument;
  ready: boolean;
  /** What the preview reports it highlights; used by the integration test. */
  state?: { sentence: string; word: string; following: boolean };
}

export interface ReadingPosition { uri: string; sentence: SourceRange | null; word: SourceRange | null }

/**
 * The Read Aloud Preview: renders Markdown like VS Code's preview and highlights the sentence and
 * word being read. VS Code's own preview cannot be highlighted by other extensions.
 */
export class PreviewPanels implements vscode.CustomTextEditorProvider, vscode.Disposable {
  static readonly viewType = 'aiMarkdownReader.preview';
  private readonly panels = new Set<Panel>();
  private position: ReadingPosition | undefined;
  private settings = { follow: true, words: true };
  /** The word right-clicked last, for Read Aloud from Here. */
  private context: { uri: vscode.Uri; line: number; character: number } | undefined;
  private readonly readRequests = new vscode.EventEmitter<{ uri: vscode.Uri; line: number; character: number }>();
  /** The listener asked to read from a place in a preview. */
  readonly onDidRequestRead = this.readRequests.event;
  private readonly commandRequests = new vscode.EventEmitter<{ uri: vscode.Uri; action: string }>();
  /** The listener pressed a player key (for example → for the next paragraph) in a preview. */
  readonly onDidRequestCommand = this.commandRequests.event;

  constructor(private readonly extensionUri: vscode.Uri, private readonly log: (message: string) => void) {}

  async resolveCustomTextEditor(document: vscode.TextDocument, panel: vscode.WebviewPanel): Promise<void> {
    const folder = vscode.Uri.joinPath(document.uri, '..');
    const workspace = vscode.workspace.getWorkspaceFolder(document.uri)?.uri;
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media'), folder, ...(workspace ? [workspace] : [])]
    };
    const entry: Panel = { panel, document, ready: false };
    this.panels.add(entry);
    panel.webview.html = this.html(panel.webview, document);
    let timer: NodeJS.Timeout | undefined;
    const disposables = [
      vscode.workspace.onDidChangeTextDocument(event => {
        if (event.document.uri.toString() !== document.uri.toString() || !event.contentChanges.length) return;
        clearTimeout(timer);
        timer = setTimeout(() => this.post(entry, { type: 'render', html: this.render(panel.webview, document) }), 150);
      }),
      vscode.workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration('markdown.preview')) panel.webview.html = this.html(panel.webview, document);
      }),
      panel.webview.onDidReceiveMessage((message: { type?: string; [key: string]: unknown }) => {
        if (message && typeof message.type === 'string') void this.handle(entry, message).catch(error => this.log(String(error)));
      })
    ];
    panel.onDidDispose(() => {
      clearTimeout(timer);
      disposables.forEach(disposable => disposable.dispose());
      this.panels.delete(entry);
    });
  }

  private async handle(entry: Panel, message: { type?: string; [key: string]: unknown }): Promise<void> {
    const at = () => ({ uri: entry.document.uri, line: Number(message.line) || 0, character: Number(message.character) || 0 });
    switch (message.type) {
      case 'ready':
        entry.ready = true;
        this.post(entry, { type: 'settings', settings: this.settings });
        if (this.position?.uri === entry.document.uri.toString()) this.post(entry, { type: 'position', position: this.position });
        break;
      case 'readFrom':
        this.readRequests.fire(at());
        break;
      case 'command':
        if (typeof message.action === 'string') this.commandRequests.fire({ uri: entry.document.uri, action: message.action });
        break;
      case 'contextTarget':
        this.context = at();
        break;
      case 'openLink':
        if (typeof message.href === 'string') await this.openLink(entry.document, message.href);
        break;
      case 'state':
        entry.state = { sentence: String(message.sentence ?? ''), word: String(message.word ?? ''), following: !!message.following };
        break;
    }
  }

  /** Read Aloud from Here, from the preview's context menu. */
  readFromContext(): void {
    if (this.context) this.readRequests.fire(this.context);
  }

  private async openLink(document: vscode.TextDocument, href: string): Promise<void> {
    if (/^(https?|mailto):/i.test(href)) {
      await vscode.env.openExternal(vscode.Uri.parse(href));
      return;
    }
    if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return;
    const [path, fragment] = href.split('#', 2);
    if (!path) return;
    const base = path.startsWith('/') ? vscode.workspace.getWorkspaceFolder(document.uri)?.uri ?? vscode.Uri.joinPath(document.uri, '..') : vscode.Uri.joinPath(document.uri, '..');
    const target = vscode.Uri.joinPath(base, decodeURIComponent(path)).with({ fragment: fragment ?? '' });
    const markdown = /\.(md|markdown|mdown|mkd|mkdn|mdwn|mdtxt|mdtext)$/i.test(target.path);
    if (markdown) await vscode.commands.executeCommand('vscode.openWith', target.with({ fragment: '' }), PreviewPanels.viewType);
    else await vscode.commands.executeCommand('vscode.open', target);
  }

  /** Highlights the reading position in every preview of that document. */
  show(position: ReadingPosition): void {
    this.position = position;
    for (const entry of this.panels) {
      if (entry.document.uri.toString() === position.uri) this.post(entry, { type: 'position', position });
    }
  }

  clear(): void {
    this.position = undefined;
    for (const entry of this.panels) this.post(entry, { type: 'clear' });
  }

  configure(settings: { follow: boolean; words: boolean }): void {
    this.settings = settings;
    for (const entry of this.panels) this.post(entry, { type: 'settings', settings });
  }

  /** Scrolls previews of the document being read back to the reading position. */
  reveal(uri: vscode.Uri): void {
    for (const entry of this.panels) {
      if (entry.document.uri.toString() === uri.toString()) this.post(entry, { type: 'reveal' });
    }
  }

  /** What the previews of a document highlight, for the integration test. */
  snapshot(uri: vscode.Uri | undefined): { previews: number; previewSentence?: string; previewWord?: string; previewFollowing?: boolean } {
    const entries = [...this.panels].filter(entry => uri && entry.document.uri.toString() === uri.toString());
    const state = entries.find(entry => entry.state)?.state;
    return { previews: entries.length, previewSentence: state?.sentence, previewWord: state?.word, previewFollowing: state?.following };
  }

  private post(entry: Panel, message: object): void {
    if (entry.ready) void entry.panel.webview.postMessage(message);
  }

  private render(webview: vscode.Webview, document: vscode.TextDocument): string {
    const folder = vscode.Uri.joinPath(document.uri, '..');
    return renderPreview(document.getText(), {
      resolveImage: src => {
        if (/^(https?:|data:)/i.test(src)) return src;
        if (!src || /^[a-z][a-z0-9+.-]*:/i.test(src)) return undefined;
        const path = decodeURIComponent(src.split(/[?#]/)[0]!);
        const base = path.startsWith('/') ? vscode.workspace.getWorkspaceFolder(document.uri)?.uri ?? folder : folder;
        return webview.asWebviewUri(vscode.Uri.joinPath(base, path)).toString();
      }
    });
  }

  private html(webview: vscode.Webview, document: vscode.TextDocument): string {
    const media = (file: string) => webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', file)).toString();
    const nonce = randomBytes(18).toString('base64');
    const config = vscode.workspace.getConfiguration('markdown.preview', document.uri);
    const css = (value: string) => value.replace(/[;{}<>]/g, '');
    const font = [
      config.get<string>('fontFamily') ? `--markdown-font-family: ${css(config.get<string>('fontFamily')!)};` : '',
      config.get<number>('fontSize') ? `--markdown-font-size: ${Number(config.get<number>('fontSize'))}px;` : '',
      config.get<number>('lineHeight') ? `--markdown-line-height: ${Number(config.get<number>('lineHeight'))};` : ''
    ].join(' ');
    let content: string;
    try {
      content = this.render(webview, document);
    } catch (error) {
      this.log(`Preview failed: ${error instanceof Error ? error.message : String(error)}`);
      content = '<p>This document could not be shown.</p>';
    }
    return `<!doctype html>
<html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} https: data:; media-src ${webview.cspSource} https: data:; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource} https: data:; script-src 'nonce-${nonce}';">
<link href="${media('preview.css')}" rel="stylesheet"><title>Read Aloud Preview</title></head>
<body style="${font}">
<main id="content">${content}</main>
<button id="back-to-reading" hidden>Back to reading</button>
<script nonce="${nonce}" src="${media('preview.js')}"></script>
</body></html>`;
  }

  dispose(): void {
    this.readRequests.dispose();
    this.commandRequests.dispose();
    for (const entry of [...this.panels]) entry.panel.dispose();
  }
}
