import * as vscode from 'vscode';
import { formatSpeed } from './speeds';
import type { Detached } from './highlight';

export interface ControlState {
  /** The document being read, if any. */
  uri?: vscode.Uri;
  title?: string;
  playing: boolean;
  waiting: boolean;
  elapsed: number;
  total: number;
  rate: number;
  skipBack: number;
  skipForward: number;
  detached: Detached;
}

const clock = (seconds: number) => {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rest = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${rest}` : `${m}:${rest}`;
};

/** Small player controls in the status bar, plus the context keys that switch the editor title buttons. */
export class Controls implements vscode.Disposable {
  private readonly back = this.item('clearMarkdown.statusBack', 'Read Aloud: Back', 'clearMarkdown.skipBack', 1003);
  private readonly play = this.item('clearMarkdown.statusPlay', 'Read Aloud: Play or Pause', 'clearMarkdown.togglePlay', 1002);
  private readonly forward = this.item('clearMarkdown.statusForward', 'Read Aloud: Forward', 'clearMarkdown.skipForward', 1001);
  private readonly speed = this.item('clearMarkdown.statusSpeed', 'Read Aloud: Speed', 'clearMarkdown.chooseSpeed', 1000);
  private readonly follow = this.item('clearMarkdown.statusFollow', 'Read Aloud: Back to Reading', 'clearMarkdown.backToReading', 999);
  private context = { active: false, playing: false, uri: '' };

  private item(id: string, name: string, command: string, priority: number): vscode.StatusBarItem {
    const item = vscode.window.createStatusBarItem(id, vscode.StatusBarAlignment.Right, priority);
    item.name = name;
    item.command = command;
    return item;
  }

  update(state: ControlState): void {
    const items = [this.back, this.play, this.forward, this.speed];
    if (!state.uri) {
      items.forEach(item => item.hide());
      this.follow.hide();
      this.setContext(false, false, '');
      return;
    }
    const file = state.title ?? 'Markdown';
    this.back.text = `$(discard) ${state.skipBack}`;
    this.back.tooltip = `Back ${state.skipBack} seconds`;
    this.forward.text = `${state.skipForward} $(redo)`;
    this.forward.tooltip = `Forward ${state.skipForward} seconds`;
    const time = `${clock(state.elapsed)} / ${clock(state.total)}`;
    this.play.text = state.playing && state.waiting ? `$(loading~spin) ${time}` : `${state.playing ? '$(debug-pause)' : '$(play)'} ${time}`;
    const tooltip = new vscode.MarkdownString(`**${state.playing ? 'Reading' : 'Paused'}:** ${escape(file)}\n\n` +
      '[Stop](command:clearMarkdown.stop "Stop reading") · [Back to reading](command:clearMarkdown.backToReading "Scroll to the sentence being read") · ' +
      '[Player](command:clearMarkdown.showPlayer "Show the Read Aloud player")');
    tooltip.isTrusted = { enabledCommands: ['clearMarkdown.stop', 'clearMarkdown.backToReading', 'clearMarkdown.showPlayer'] };
    tooltip.supportThemeIcons = true;
    this.play.tooltip = tooltip;
    this.speed.text = formatSpeed(state.rate);
    this.speed.tooltip = 'Reading speed';
    items.forEach(item => item.show());
    if (state.detached) {
      this.follow.text = `$(${state.detached === 'above' ? 'arrow-up' : 'arrow-down'}) Back to reading`;
      this.follow.tooltip = 'Scroll to the sentence being read and follow it again';
      this.follow.show();
    } else this.follow.hide();
    this.setContext(true, state.playing, state.uri.toString());
  }

  private setContext(active: boolean, playing: boolean, uri: string): void {
    if (active !== this.context.active) void vscode.commands.executeCommand('setContext', 'clearMarkdown.playerActive', active);
    if (playing !== this.context.playing) void vscode.commands.executeCommand('setContext', 'clearMarkdown.playing', playing);
    if (uri !== this.context.uri) void vscode.commands.executeCommand('setContext', 'clearMarkdown.readingResources', uri ? [uri] : []);
    this.context = { active, playing, uri };
  }

  dispose(): void {
    for (const item of [this.back, this.play, this.forward, this.speed, this.follow]) item.dispose();
  }
}

function escape(text: string): string {
  return text.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, '\\$&');
}
