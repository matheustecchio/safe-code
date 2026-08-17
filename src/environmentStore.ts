import { execFile } from "child_process";
import * as vscode from "vscode";
import {
  ensureEnvironmentFileIgnored,
  upsertEnvironmentExample,
  upsertEnvironmentValue
} from "./environmentFixCore";

export class EnvironmentStore {
  public constructor(private readonly workspaceFolder: vscode.WorkspaceFolder) {}

  public async write(environmentVariableName: string, secretValue: string): Promise<void> {
    const environmentUri = vscode.Uri.joinPath(this.workspaceFolder.uri, ".env");
    const exampleUri = vscode.Uri.joinPath(this.workspaceFolder.uri, ".env.example");
    const gitIgnoreUri = vscode.Uri.joinPath(this.workspaceFolder.uri, ".gitignore");
    const [environmentFile, exampleFile, gitIgnoreFile, environmentTracked] = await Promise.all([
      readSafeTextFile(environmentUri),
      readSafeTextFile(exampleUri),
      readSafeTextFile(gitIgnoreUri),
      isEnvironmentFileTracked(this.workspaceFolder.uri)
    ]);

    if (environmentTracked) {
      throw new Error(".env is already tracked by Git. Remove it from version control before using this fix.");
    }

    const nextEnvironment = upsertEnvironmentValue(
      environmentFile.content,
      environmentVariableName,
      secretValue
    );
    const nextExample = upsertEnvironmentExample(exampleFile.content, environmentVariableName);
    const nextGitIgnore = ensureEnvironmentFileIgnored(gitIgnoreFile.content);

    await writeTextFileIfChanged(gitIgnoreUri, gitIgnoreFile.content, nextGitIgnore);
    await writeTextFileIfChanged(environmentUri, environmentFile.content, nextEnvironment);
    await writeTextFileIfChanged(exampleUri, exampleFile.content, nextExample);
  }
}

type SafeTextFile = {
  content: string;
};

async function readSafeTextFile(uri: vscode.Uri): Promise<SafeTextFile> {
  try {
    const stat = await vscode.workspace.fs.stat(uri);
    if ((stat.type & vscode.FileType.SymbolicLink) !== 0 || (stat.type & vscode.FileType.File) === 0) {
      throw new Error(`${uri.fsPath} must be a regular file.`);
    }
    const contents = await vscode.workspace.fs.readFile(uri);
    return { content: Buffer.from(contents).toString("utf8") };
  } catch (error) {
    if (error instanceof vscode.FileSystemError && error.code === "FileNotFound") {
      return { content: "" };
    }
    throw error;
  }
}

async function writeTextFileIfChanged(uri: vscode.Uri, currentContent: string, nextContent: string): Promise<void> {
  if (currentContent === nextContent) {
    return;
  }
  await vscode.workspace.fs.writeFile(uri, Buffer.from(nextContent));
}

async function isEnvironmentFileTracked(workspaceFolderUri: vscode.Uri): Promise<boolean> {
  if (workspaceFolderUri.scheme !== "file") {
    return false;
  }

  return await new Promise<boolean>((resolve, reject) => {
    execFile(
      "git",
      ["-C", workspaceFolderUri.fsPath, "ls-files", "--error-unmatch", "--", ".env"],
      { windowsHide: true },
      (error, _stdout, stderr) => {
        if (!error) {
          resolve(true);
          return;
        }

        const code = (error as { code?: number | string }).code;
        if (code === 1 || code === "ENOENT" || (code === 128 && stderr.includes("not a git repository"))) {
          resolve(false);
          return;
        }

        reject(error);
      }
    );
  });
}
