import * as crypto from "crypto";
import * as vscode from "vscode";

const ignoredWarningsKey = "safeCode.ignoredWarnings";

export type IgnoredWarning = {
  filePath: string;
  lineHash: string;
  ruleId: string;
};

export class IgnoreStore {
  public constructor(private readonly workspaceState: vscode.Memento) {}

  public isIgnored(uri: vscode.Uri, lineText: string, ruleId: string): boolean {
    const warning = this.createIgnoredWarning(uri, lineText, ruleId);
    return this.getAll().some((ignoredWarning) => {
      return (
        ignoredWarning.filePath === warning.filePath &&
        ignoredWarning.lineHash === warning.lineHash &&
        ignoredWarning.ruleId === warning.ruleId
      );
    });
  }

  public async add(uri: vscode.Uri, lineText: string, ruleId: string): Promise<void> {
    const warning = this.createIgnoredWarning(uri, lineText, ruleId);
    const ignoredWarnings = this.getAll();
    const alreadyIgnored = ignoredWarnings.some((ignoredWarning) => {
      return (
        ignoredWarning.filePath === warning.filePath &&
        ignoredWarning.lineHash === warning.lineHash &&
        ignoredWarning.ruleId === warning.ruleId
      );
    });

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

  private createIgnoredWarning(uri: vscode.Uri, lineText: string, ruleId: string): IgnoredWarning {
    return {
      filePath: getWorkspaceFilePath(uri),
      lineHash: hashLineText(lineText),
      ruleId
    };
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

function hashLineText(lineText: string): string {
  return crypto.createHash("sha256").update(lineText.trim()).digest("hex").slice(0, 24);
}

function isIgnoredWarning(value: unknown): value is IgnoredWarning {
  if (!value || typeof value !== "object") {
    return false;
  }

  const warning = value as Record<string, unknown>;
  return (
    typeof warning.filePath === "string" &&
    typeof warning.lineHash === "string" &&
    typeof warning.ruleId === "string"
  );
}
