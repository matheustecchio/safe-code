import * as vscode from "vscode";
import {
  createIgnoredWarning,
  IgnoredWarning,
  matchesIgnoredWarning,
  normalizeProjectFilePath
} from "./ignoreCore";
import {
  addProjectIgnoredWarning,
  getProjectIgnoreFileErrorMessage,
  normalizeProjectIgnoreFileError,
  projectIgnoreConfigFileName,
  readProjectIgnoreConfigFile
} from "./projectIgnoreFile";

export { getProjectIgnoreFileErrorMessage, projectIgnoreConfigFileName } from "./projectIgnoreFile";

export class ProjectIgnoreStore {
  private readonly ignoredWarningsByWorkspace = new Map<string, IgnoredWarning[]>();
  private readonly lastErrorByWorkspace = new Map<string, string>();
  private readonly operationTailsByWorkspace = new Map<string, Promise<void>>();

  public constructor(private readonly output: vscode.OutputChannel) {}

  public async reloadAll(): Promise<void> {
    const currentWorkspaceKeys = new Set((vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.toString()));
    for (const workspaceKey of this.ignoredWarningsByWorkspace.keys()) {
      if (!currentWorkspaceKeys.has(workspaceKey)) {
        this.ignoredWarningsByWorkspace.delete(workspaceKey);
      }
    }
    for (const workspaceKey of this.lastErrorByWorkspace.keys()) {
      if (!currentWorkspaceKeys.has(workspaceKey)) {
        this.lastErrorByWorkspace.delete(workspaceKey);
      }
    }
    for (const workspaceFolder of vscode.workspace.workspaceFolders ?? []) {
      await this.reload(workspaceFolder);
    }
  }

  public async reloadForUri(uri: vscode.Uri): Promise<void> {
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
    if (workspaceFolder) {
      await this.reload(workspaceFolder);
    }
  }

  public isIgnored(uri: vscode.Uri, lineText: string, ruleId: string): boolean {
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
    if (!workspaceFolder) {
      return false;
    }

    const warning = createIgnoredWarning(getProjectFilePath(uri), lineText, ruleId);
    const ignoredWarnings = this.ignoredWarningsByWorkspace.get(workspaceFolder.uri.toString()) ?? [];
    return ignoredWarnings.some((candidate) => matchesIgnoredWarning(candidate, warning));
  }

  public isConfigUri(uri: vscode.Uri): boolean {
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
    if (!workspaceFolder) {
      return false;
    }

    return uri.toString() === getConfigUri(workspaceFolder).toString();
  }

  public async add(uri: vscode.Uri, lineText: string, ruleId: string): Promise<boolean> {
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
    if (!workspaceFolder) {
      throw new Error("The warning is not inside an open workspace folder.");
    }

    const workspaceKey = workspaceFolder.uri.toString();
    return await this.runSerialized(workspaceKey, async () => {
      try {
        const warning = createIgnoredWarning(getProjectFilePath(uri), lineText, ruleId);
        const update = await addProjectIgnoredWarning(getConfigPath(workspaceFolder, "write-failed"), warning);
        this.ignoredWarningsByWorkspace.set(workspaceKey, update.config.ignoredWarnings);
        this.lastErrorByWorkspace.delete(workspaceKey);
        return update.changed;
      } catch (error) {
        this.ignoredWarningsByWorkspace.delete(workspaceKey);
        throw normalizeProjectIgnoreFileError(error, "write-failed");
      }
    });
  }

  private async reload(workspaceFolder: vscode.WorkspaceFolder): Promise<void> {
    const workspaceKey = workspaceFolder.uri.toString();
    await this.runSerialized(workspaceKey, async () => {
      try {
        const config = await readProjectIgnoreConfigFile(getConfigPath(workspaceFolder, "read-failed"));
        this.ignoredWarningsByWorkspace.set(workspaceKey, config.ignoredWarnings);
        this.lastErrorByWorkspace.delete(workspaceKey);
      } catch (error) {
        this.ignoredWarningsByWorkspace.delete(workspaceKey);
        const detail = getProjectIgnoreFileErrorMessage(error, "read-failed");
        const message = `Safe Code ignored project configuration. ${detail}`;
        if (this.lastErrorByWorkspace.get(workspaceKey) !== message) {
          this.lastErrorByWorkspace.set(workspaceKey, message);
          this.output.appendLine(message);
          console.warn(message);
        }
      }
    });
  }

  private runSerialized<T>(workspaceKey: string, operation: () => Promise<T>): Promise<T> {
    const previousTail = this.operationTailsByWorkspace.get(workspaceKey) ?? Promise.resolve();
    const result = previousTail.then(operation);
    const currentTail = result.then(
      () => undefined,
      () => undefined
    );
    this.operationTailsByWorkspace.set(workspaceKey, currentTail);
    void currentTail.then(() => {
      if (this.operationTailsByWorkspace.get(workspaceKey) === currentTail) {
        this.operationTailsByWorkspace.delete(workspaceKey);
      }
    });
    return result;
  }
}

function getConfigUri(workspaceFolder: vscode.WorkspaceFolder): vscode.Uri {
  return vscode.Uri.joinPath(workspaceFolder.uri, projectIgnoreConfigFileName);
}

function getConfigPath(
  workspaceFolder: vscode.WorkspaceFolder,
  failureCode: "read-failed" | "write-failed"
): string {
  const configUri = getConfigUri(workspaceFolder);
  if (configUri.scheme !== "file") {
    throw normalizeProjectIgnoreFileError(undefined, failureCode);
  }
  return configUri.fsPath;
}

function getProjectFilePath(uri: vscode.Uri): string {
  return normalizeProjectFilePath(vscode.workspace.asRelativePath(uri, false));
}
