import * as vscode from "vscode";
import {
  createIgnoredWarning,
  IgnoredWarning,
  matchesIgnoredWarning,
  normalizeProjectFilePath,
  parseProjectIgnoreConfig,
  ProjectIgnoreConfig,
  serializeProjectIgnoreConfig
} from "./ignoreCore";

export const projectIgnoreConfigFileName = ".safe-code.json";

export class ProjectIgnoreStore {
  private readonly ignoredWarningsByWorkspace = new Map<string, IgnoredWarning[]>();
  private readonly lastErrorByWorkspace = new Map<string, string>();

  public constructor(private readonly output: vscode.OutputChannel) {}

  public async reloadAll(): Promise<void> {
    this.ignoredWarningsByWorkspace.clear();
    const currentWorkspaceKeys = new Set((vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.toString()));
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

    const configUri = getConfigUri(workspaceFolder);
    const config = await this.readConfig(configUri);
    const warning = createIgnoredWarning(getProjectFilePath(uri), lineText, ruleId);
    if (config.ignoredWarnings.some((candidate) => matchesIgnoredWarning(candidate, warning))) {
      this.ignoredWarningsByWorkspace.set(workspaceFolder.uri.toString(), config.ignoredWarnings);
      return false;
    }

    const updatedConfig: ProjectIgnoreConfig = {
      version: 1,
      ignoredWarnings: [...config.ignoredWarnings, warning].sort(compareWarnings)
    };
    await vscode.workspace.fs.writeFile(configUri, Buffer.from(serializeProjectIgnoreConfig(updatedConfig), "utf8"));
    this.ignoredWarningsByWorkspace.set(workspaceFolder.uri.toString(), updatedConfig.ignoredWarnings);
    return true;
  }

  private async reload(workspaceFolder: vscode.WorkspaceFolder): Promise<void> {
    const workspaceKey = workspaceFolder.uri.toString();
    try {
      const config = await this.readConfig(getConfigUri(workspaceFolder));
      this.ignoredWarningsByWorkspace.set(workspaceKey, config.ignoredWarnings);
      this.lastErrorByWorkspace.delete(workspaceKey);
    } catch (error) {
      this.ignoredWarningsByWorkspace.delete(workspaceKey);
      const message = `Safe Code ignored invalid project configuration at ${getConfigUri(workspaceFolder).fsPath}: ${String(error)}`;
      if (this.lastErrorByWorkspace.get(workspaceKey) !== message) {
        this.lastErrorByWorkspace.set(workspaceKey, message);
        this.output.appendLine(message);
        console.warn(message);
      }
    }
  }

  private async readConfig(configUri: vscode.Uri): Promise<ProjectIgnoreConfig> {
    try {
      const content = await vscode.workspace.fs.readFile(configUri);
      return parseProjectIgnoreConfig(Buffer.from(content).toString("utf8"));
    } catch (error) {
      if (isFileNotFound(error)) {
        return { version: 1, ignoredWarnings: [] };
      }
      throw error;
    }
  }
}

function getConfigUri(workspaceFolder: vscode.WorkspaceFolder): vscode.Uri {
  return vscode.Uri.joinPath(workspaceFolder.uri, projectIgnoreConfigFileName);
}

function getProjectFilePath(uri: vscode.Uri): string {
  return normalizeProjectFilePath(vscode.workspace.asRelativePath(uri, false));
}

function isFileNotFound(error: unknown): boolean {
  return error instanceof vscode.FileSystemError && error.code === "FileNotFound";
}

function compareWarnings(left: IgnoredWarning, right: IgnoredWarning): number {
  return (
    left.filePath.localeCompare(right.filePath) ||
    left.ruleId.localeCompare(right.ruleId) ||
    left.lineHash.localeCompare(right.lineHash)
  );
}
