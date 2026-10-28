import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';

function readerTabs(): vscode.Tab[] {
  return vscode.window.tabGroups.all.flatMap(group => group.tabs)
    .filter(tab => tab.input instanceof vscode.TabInputWebview);
}

async function waitForReader(): Promise<void> {
  if (readerTabs().length) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      subscription.dispose();
      reject(new Error('Reader did not appear within ten seconds.'));
    }, 10_000);
    const subscription = vscode.window.tabGroups.onDidChangeTabs(() => {
      if (readerTabs().length) {
        clearTimeout(timer);
        subscription.dispose();
        resolve();
      }
    });
  });
}

export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension('orexii.clear-markdown-reader');
  assert.ok(extension, 'extension is discoverable');
  await extension.activate();
  const commands = await vscode.commands.getCommands(true);
  assert.ok(commands.includes('clearMarkdown.read'));
  assert.ok(commands.includes('clearMarkdown.readSelection'));
  const document = await vscode.workspace.openTextDocument({
    language: 'markdown',
    content: '# Native desktop smoke test\n\n- **First:** flowing prose.\n\n| Service | State |\n| --- | --- |\n| Mail | Ready |'
  });
  await vscode.window.showTextDocument(document);
  await vscode.commands.executeCommand('clearMarkdown.read');
  await waitForReader();
  assert.equal(readerTabs().length, 1, 'reader panel opens after native voice discovery');
  await vscode.window.tabGroups.close(readerTabs());
  const editor = await vscode.window.showTextDocument(document);
  editor.selection = new vscode.Selection(new vscode.Position(2, 0), new vscode.Position(2, 28));
  await vscode.commands.executeCommand('clearMarkdown.readSelection');
  await waitForReader();
  assert.equal(readerTabs().length, 1, 'selection reader also opens');
  await vscode.window.tabGroups.close(readerTabs());
  console.log('Extension host activation, full-document reader, and selection reader passed.');
}
