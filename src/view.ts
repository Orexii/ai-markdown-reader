import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { playerMarkup } from './markup';

export interface PlayerMessage {
  type: string;
  [key: string]: unknown;
}

/**
 * The small Read Aloud view. VS Code only plays sound from webviews, and only after a click or key
 * press inside one, so this view hosts the audio while the text is highlighted in the editor.
 */
export class PlayerView implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly id = 'aiMarkdownReader.player';
  private view: vscode.WebviewView | undefined;
  private loaded = false;
  private readonly received = new vscode.EventEmitter<PlayerMessage>();
  /** Messages from the player. A `ready` message means it has (re)loaded and needs the current state. */
  readonly onMessage = this.received.event;
  private readonly closed = new vscode.EventEmitter<void>();
  /** The player was destroyed (for example the listener hid the view), and with it any sound. */
  readonly onDidClose = this.closed.event;

  constructor(private readonly extensionUri: vscode.Uri, private readonly skips: () => { skipBack: number; skipForward: number }) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    this.loaded = false;
    const media = vscode.Uri.joinPath(this.extensionUri, 'media');
    view.webview.options = { enableScripts: true, localResourceRoots: [media] };
    const uri = (file: string) => view.webview.asWebviewUri(vscode.Uri.joinPath(media, file)).toString();
    const { skipBack, skipForward } = this.skips();
    view.webview.html = playerMarkup({
      cspSource: view.webview.cspSource, nonce: randomBytes(18).toString('base64'), css: uri('player.css'), script: uri('player.js'), skipBack, skipForward
    });
    view.webview.onDidReceiveMessage((message: unknown) => {
      if (this.view !== view || !message || typeof message !== 'object' || typeof (message as PlayerMessage).type !== 'string') return;
      if ((message as PlayerMessage).type === 'ready') this.loaded = true;
      this.received.fire(message as PlayerMessage);
    });
    view.onDidDispose(() => {
      if (this.view !== view) return;
      this.view = undefined;
      this.loaded = false;
      this.closed.fire();
    });
  }

  /** True once the player script is running and can receive messages. */
  get ready(): boolean {
    return !!this.view && this.loaded;
  }

  get visible(): boolean {
    return !!this.view?.visible;
  }

  set description(value: string | undefined) {
    if (this.view) this.view.description = value;
  }

  post(message: object): void {
    if (this.view && this.loaded) void this.view.webview.postMessage(message);
  }

  /** Shows the player, creating it if VS Code has not yet. `focus` lets a key press start playback. */
  async reveal(focus: boolean): Promise<void> {
    if (this.view) this.view.show(!focus);
    else await vscode.commands.executeCommand(`${PlayerView.id}.focus`);
  }

  dispose(): void {
    this.received.dispose();
    this.closed.dispose();
  }
}
