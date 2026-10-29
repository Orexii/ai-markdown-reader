import * as vscode from 'vscode';

/** The extension was called Clear Markdown Reader (orexii.clear-markdown-reader) before 0.8. */
const OLD_SECTION = 'clearMarkdown';
const NEW_SECTION = 'aiMarkdownReader';

/**
 * Copies settings saved under the old name (clearMarkdown.*) to the new one (aiMarkdownReader.*), then
 * removes the old entries. A value already set under the new name is kept.
 */
export async function migrateSettings(extension: vscode.Extension<unknown>, log: (message: string) => void): Promise<string[]> {
  const declared = Object.keys((extension.packageJSON as { contributes?: { configuration?: { properties?: object } } }).contributes?.configuration?.properties ?? {});
  const keys = declared.filter(key => key.startsWith(`${NEW_SECTION}.`)).map(key => key.slice(NEW_SECTION.length + 1));
  const moved: string[] = [];
  const targets = [
    [vscode.ConfigurationTarget.Global, 'globalValue'],
    [vscode.ConfigurationTarget.Workspace, 'workspaceValue']
  ] as const;
  for (const key of keys) {
    const before = vscode.workspace.getConfiguration(OLD_SECTION).inspect(key);
    if (!before) continue;
    for (const [target, scope] of targets) {
      const value = before[scope];
      if (value === undefined) continue;
      try {
        if (vscode.workspace.getConfiguration(NEW_SECTION).inspect(key)?.[scope] === undefined) {
          await vscode.workspace.getConfiguration(NEW_SECTION).update(key, value, target);
          moved.push(`${NEW_SECTION}.${key}`);
        }
        // Removing an old key works even though it is no longer declared.
        await vscode.workspace.getConfiguration(OLD_SECTION).update(key, undefined, target);
      } catch (error) {
        log(`Could not move the setting ${OLD_SECTION}.${key}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  if (moved.length) log(`Moved settings from the old name: ${moved.join(', ')}.`);
  return moved;
}
