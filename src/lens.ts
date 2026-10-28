import * as vscode from 'vscode';
import type { Reader } from './reader';

/** Offers Copilot descriptions above the tables and code blocks of the document being read. */
export class DescribeLens implements vscode.CodeLensProvider, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.changed.event;
  private readonly subscription: vscode.Disposable;

  constructor(private readonly reader: Reader) {
    this.subscription = reader.onDidChangeReading(() => this.changed.fire());
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    return this.reader.describable(document.uri).map(({ block, kind, line, described }) => {
      const range = new vscode.Range(line, 0, line, 0);
      return new vscode.CodeLens(range, described
        ? { title: '$(sparkle) Reading Copilot\'s description · use the original', command: 'clearMarkdown.restoreBlock', arguments: [document.uri, block] }
        : {
          title: kind === 'table' ? '$(sparkle) Describe this table with Copilot' : '$(sparkle) Explain this code with Copilot',
          tooltip: 'Ask Copilot for a spoken description, review it, then hear it instead of the literal reading',
          command: 'clearMarkdown.describeBlock', arguments: [document.uri, block]
        });
    });
  }

  dispose(): void {
    this.subscription.dispose();
    this.changed.dispose();
  }
}
