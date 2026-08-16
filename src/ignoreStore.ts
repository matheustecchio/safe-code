import * as vscode from "vscode";
import { createIgnoredWarning, IgnoredWarning, isIgnoredWarning, matchesIgnoredWarning } from "./ignoreCore";

const ignoredWarningsKey = "safeCode.ignoredWarnings";

export class IgnoreStore {
  public constructor(private readonly workspaceState: vscode.Memento) {}

  public isIgnored(uri: vscode.Uri, lineText: string, ruleId: string): boolean {
    const warning = createIgnoredWarning(getWorkspaceFilePath(uri), lineText, ruleId);
    return this.getAll().some((ignoredWarning) => matchesIgnoredWarning(ignoredWarning, warning));
  }

  public async add(uri: vscode.Uri, lineText: string, ruleId: string): Promise<void> {
    const warning = createIgnoredWarning(getWorkspaceFilePath(uri), lineText, ruleId);
    const ignoredWarnings = this.getAll();
    const alreadyIgnored = ignoredWarnings.some((ignoredWarning) => matchesIgnoredWarning(ignoredWarning, warning));

    if (alreadyIgnored) {
      return;
    }

    await this.workspaceState.update(ignoredWarningsKey, [...ignoredWarnings, warning]);
  }

  private getAll(): IgnoredWarning[] {
    const ignoredWarnings = this.workspaceState.get<unknown>(ignoredWarningsKey, []);
    if (!Array.isArray(ignoredWarnings)) {
      return [];
    }

    return ignoredWarnings.filter(isIgnoredWarning);
  }
}

function getWorkspaceFilePath(uri: vscode.Uri): string {
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
  if (!workspaceFolder) {
    return uri.fsPath;
  }

  const relativePath = vscode.workspace.asRelativePath(uri, false).replace(/\\/g, "/");
  return `${workspaceFolder.name}/${relativePath}`;
}
