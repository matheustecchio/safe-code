import * as vscode from "vscode";
import {
  analyzeEnvironmentAssignment,
  EnvironmentVariableConflictError,
  isSupportedEnvironmentFixFile
} from "./environmentFixCore";
import { EnvironmentStore } from "./environmentStore";
import { IgnoreStore } from "./ignoreStore";
import { projectIgnoreConfigFileName, ProjectIgnoreStore } from "./projectIgnoreStore";
import { defaultIgnoredPaths, scanDocument, ScannerOptions, shouldScanDocument, shouldScanUri } from "./scanner";

const diagnosticSource = "Safe Code";
const ignoreWarningCommand = "safeCode.ignoreWarning";
const ignoreWarningForProjectCommand = "safeCode.ignoreWarningForProject";
const moveSecretToEnvCommand = "safeCode.moveSecretToEnv";
const scanWorkspaceCommand = "safeCode.scanWorkspace";

type WorkspaceScanResult = {
  cancelled: boolean;
  failedFiles: number;
  findings: number;
  scannedFiles: number;
};

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const diagnostics = vscode.languages.createDiagnosticCollection("safe-code");
  const output = vscode.window.createOutputChannel("Safe Code");
  const ignoreStore = new IgnoreStore(context.workspaceState);
  const projectIgnoreStore = new ProjectIgnoreStore(output);
  const pendingScans = new Map<string, ReturnType<typeof setTimeout>>();
  const diagnosticUris = new Map<string, vscode.Uri>();
  let workspaceScanInProgress = false;
  let workspaceRescanRequested = false;

  await projectIgnoreStore.reloadAll();

  const scanNow = (document: vscode.TextDocument, options = getScannerOptions()): number => {
    const key = document.uri.toString();

    if (!isEnabled() || !shouldScanDocument(document, options)) {
      diagnostics.delete(document.uri);
      diagnosticUris.delete(key);
      return 0;
    }

    const documentDiagnostics = scanDocument(document, options)
      .filter((finding) => {
        return (
          !ignoreStore.isIgnored(document.uri, finding.lineText, finding.ruleId) &&
          !projectIgnoreStore.isIgnored(document.uri, finding.lineText, finding.ruleId)
        );
      })
      .map((finding) => {
        const diagnostic = new vscode.Diagnostic(finding.range, finding.message, vscode.DiagnosticSeverity.Warning);
        diagnostic.source = diagnosticSource;
        diagnostic.code = finding.ruleId;
        return diagnostic;
      });

    diagnostics.set(document.uri, documentDiagnostics);
    if (documentDiagnostics.length > 0) {
      diagnosticUris.set(key, document.uri);
    } else {
      diagnosticUris.delete(key);
    }

    return documentDiagnostics.length;
  };

  const queueScan = (document: vscode.TextDocument): void => {
    const key = document.uri.toString();
    const pendingScan = pendingScans.get(key);

    if (pendingScan) {
      clearTimeout(pendingScan);
    }

    pendingScans.set(
      key,
      setTimeout(() => {
        pendingScans.delete(key);
        scanNow(document);
      }, 250)
    );
  };

  const queueUriScan = (uri: vscode.Uri): void => {
    const key = uri.toString();
    const pendingScan = pendingScans.get(key);

    if (pendingScan) {
      clearTimeout(pendingScan);
    }

    pendingScans.set(
      key,
      setTimeout(() => {
        pendingScans.delete(key);
        void scanUri(uri);
      }, 250)
    );
  };

  const scanUri = async (uri: vscode.Uri): Promise<void> => {
    const options = getScannerOptions();
    if (!isEnabled() || !shouldScanUri(uri, options)) {
      removeDiagnostics(uri);
      return;
    }

    try {
      const document = await vscode.workspace.openTextDocument(uri);
      scanNow(document, options);
    } catch (error) {
      removeDiagnostics(uri);
      console.warn(`Safe Code could not scan ${uri.fsPath}: ${String(error)}`);
    }
  };

  const removeDiagnostics = (uri: vscode.Uri): void => {
    const key = uri.toString();
    const pendingScan = pendingScans.get(key);
    if (pendingScan) {
      clearTimeout(pendingScan);
      pendingScans.delete(key);
    }

    diagnostics.delete(uri);
    diagnosticUris.delete(key);
  };

  const scanOpenDocuments = (): void => {
    for (const document of vscode.workspace.textDocuments) {
      scanNow(document);
    }
  };

  const clearTrackedDiagnostics = (): void => {
    diagnostics.clear();
    diagnosticUris.clear();
  };

  const scanWorkspace = async (interactive: boolean): Promise<void> => {
    if (!vscode.workspace.workspaceFolders?.length) {
      if (interactive) {
        void vscode.window.showWarningMessage("Safe Code needs an open folder or workspace to scan.");
      }
      return;
    }

    if (!isEnabled()) {
      if (interactive) {
        void vscode.window.showInformationMessage("Safe Code is disabled in settings.");
      }
      return;
    }

    if (workspaceScanInProgress) {
      if (!interactive) {
        workspaceRescanRequested = true;
      }
      if (interactive) {
        void vscode.window.showInformationMessage("A Safe Code workspace scan is already running.");
      }
      return;
    }

    workspaceScanInProgress = true;
    try {
      await projectIgnoreStore.reloadAll();
      const result = await vscode.window.withProgress(
        {
          location: interactive ? vscode.ProgressLocation.Notification : vscode.ProgressLocation.Window,
          title: "Safe Code: Scanning workspace",
          cancellable: interactive
        },
        async (progress, token): Promise<WorkspaceScanResult> => {
          const options = getScannerOptions();
          const previousDiagnosticUris = new Map(diagnosticUris);
          const currentDiagnosticKeys = new Set<string>();
          let discoveredUris: vscode.Uri[];
          try {
            discoveredUris = await vscode.workspace.findFiles(
              "**/*",
              createExcludeGlob(options.ignoredPaths),
              undefined,
              token
            );
          } catch (error) {
            if (token.isCancellationRequested) {
              return { cancelled: true, failedFiles: 0, findings: 0, scannedFiles: 0 };
            }
            throw error;
          }
          const candidateUris = discoveredUris.filter((uri) => shouldScanUri(uri, options));
          let failedFiles = 0;
          let findings = 0;
          let scannedFiles = 0;

          for (const uri of candidateUris) {
            if (token.isCancellationRequested) {
              break;
            }

            try {
              const document = await vscode.workspace.openTextDocument(uri);
              const fileFindings = scanNow(document, options);
              const key = uri.toString();
              findings += fileFindings;
              if (fileFindings > 0) {
                currentDiagnosticKeys.add(key);
              }
            } catch (error) {
              failedFiles += 1;
              console.warn(`Safe Code could not scan ${uri.fsPath}: ${String(error)}`);
            }

            scannedFiles += 1;
            progress.report({
              message: `${scannedFiles} of ${candidateUris.length} files`,
              increment: candidateUris.length > 0 ? 100 / candidateUris.length : undefined
            });
          }

          const cancelled = token.isCancellationRequested;
          if (!cancelled) {
            for (const [key, uri] of previousDiagnosticUris) {
              if (!currentDiagnosticKeys.has(key)) {
                diagnostics.delete(uri);
                diagnosticUris.delete(key);
              }
            }
          }

          return { cancelled, failedFiles, findings, scannedFiles };
        }
      );

      if (result.cancelled) {
        if (interactive) {
          void vscode.window.showInformationMessage(
            `Safe Code workspace scan cancelled after ${result.scannedFiles} files. Processed results were kept.`
          );
        }
        return;
      }

      if (interactive) {
        const failureSuffix = result.failedFiles > 0 ? ` ${result.failedFiles} files could not be read.` : "";
        void vscode.window.showInformationMessage(
          `Safe Code scanned ${result.scannedFiles} files and found ${result.findings} warnings.${failureSuffix}`
        );
      }
    } catch (error) {
      void vscode.window.showErrorMessage(`Safe Code workspace scan failed: ${String(error)}`);
    } finally {
      workspaceScanInProgress = false;
      if (workspaceRescanRequested) {
        workspaceRescanRequested = false;
        void scanWorkspace(false);
      }
    }
  };

  const refreshProjectConfiguration = async (uri: vscode.Uri): Promise<void> => {
    await projectIgnoreStore.reloadForUri(uri);
    if (isEnabled()) {
      void scanWorkspace(false);
    }
  };

  const handleFileCreateOrChange = (uri: vscode.Uri): void => {
    if (projectIgnoreStore.isConfigUri(uri)) {
      void refreshProjectConfiguration(uri);
      return;
    }

    queueUriScan(uri);
  };

  const handleFileDelete = (uri: vscode.Uri): void => {
    if (projectIgnoreStore.isConfigUri(uri)) {
      void refreshProjectConfiguration(uri);
      return;
    }

    removeDiagnostics(uri);
  };

  const fileWatcher = vscode.workspace.createFileSystemWatcher("**/*");

  context.subscriptions.push(
    diagnostics,
    output,
    fileWatcher,
    fileWatcher.onDidCreate(handleFileCreateOrChange),
    fileWatcher.onDidChange(handleFileCreateOrChange),
    fileWatcher.onDidDelete(handleFileDelete),
    vscode.workspace.onDidOpenTextDocument(queueScan),
    vscode.workspace.onDidChangeTextDocument((event) => queueScan(event.document)),
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor) {
        queueScan(editor.document);
      }
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration("safeCode")) {
        return;
      }

      if (!isEnabled()) {
        clearTrackedDiagnostics();
        return;
      }

      clearTrackedDiagnostics();
      if (shouldScanWorkspaceOnStartup()) {
        void scanWorkspace(false);
      } else {
        scanOpenDocuments();
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(async () => {
      await projectIgnoreStore.reloadAll();
      clearTrackedDiagnostics();
      if (isEnabled()) {
        void scanWorkspace(false);
      }
    }),
    vscode.languages.registerCodeActionsProvider(
      { scheme: "file" },
      new SafeCodeActionProvider(),
      { providedCodeActionKinds: SafeCodeActionProvider.providedCodeActionKinds }
    ),
    vscode.commands.registerCommand(
      moveSecretToEnvCommand,
      async (uri: vscode.Uri, range: vscode.Range, ruleId: string) => {
        try {
          await moveSecretToEnvironment(uri, range, ruleId);
        } catch (error) {
          const message =
            error instanceof EnvironmentVariableConflictError
              ? `Safe Code did not move the secret: ${error.message}`
              : `Safe Code could not move the secret to .env: ${String(error)}`;
          output.appendLine(message);
          void vscode.window.showErrorMessage(message);
        }
      }
    ),
    vscode.commands.registerCommand(ignoreWarningCommand, async (uri: vscode.Uri, line: number, ruleId: string) => {
      const document = await vscode.workspace.openTextDocument(uri);
      if (line < 0 || line >= document.lineCount) {
        return;
      }

      await ignoreStore.add(uri, document.lineAt(line).text, ruleId);
      scanNow(document);
    }),
    vscode.commands.registerCommand(
      ignoreWarningForProjectCommand,
      async (uri: vscode.Uri, line: number, ruleId: string) => {
        const document = await vscode.workspace.openTextDocument(uri);
        if (line < 0 || line >= document.lineCount) {
          return;
        }

        try {
          await projectIgnoreStore.add(uri, document.lineAt(line).text, ruleId);
          scanNow(document);
        } catch (error) {
          const message = `Safe Code could not update ${projectIgnoreConfigFileName}: ${String(error)}`;
          output.appendLine(message);
          void vscode.window.showErrorMessage(message);
        }
      }
    ),
    vscode.commands.registerCommand("safeCode.scanOpenFiles", () => {
      scanOpenDocuments();
      vscode.window.showInformationMessage("Safe Code scanned open workspace files.");
    }),
    vscode.commands.registerCommand(scanWorkspaceCommand, () => scanWorkspace(true))
  );

  if (shouldScanWorkspaceOnStartup()) {
    void scanWorkspace(false);
  } else {
    scanOpenDocuments();
  }
}

export function deactivate(): void {
  // VS Code disposes subscriptions registered during activation.
}

class SafeCodeActionProvider implements vscode.CodeActionProvider {
  public static readonly providedCodeActionKinds = [vscode.CodeActionKind.QuickFix];

  public provideCodeActions(
    document: vscode.TextDocument,
    _range: vscode.Range | vscode.Selection,
    context: vscode.CodeActionContext
  ): vscode.CodeAction[] {
    return context.diagnostics.filter(isSafeCodeDiagnostic).flatMap((diagnostic) => {
      const ruleId = String(diagnostic.code ?? "");
      const actions: vscode.CodeAction[] = [];
      const environmentAction = createEnvironmentCodeAction(document, diagnostic, ruleId);
      if (environmentAction) {
        actions.push(environmentAction);
      }

      const localAction = new vscode.CodeAction("Safe Code: Ignore this warning", vscode.CodeActionKind.QuickFix);
      localAction.command = {
        command: ignoreWarningCommand,
        title: "Ignore this warning",
        arguments: [document.uri, diagnostic.range.start.line, ruleId]
      };
      localAction.diagnostics = [diagnostic];
      localAction.isPreferred = true;

      const projectAction = new vscode.CodeAction(
        "Safe Code: Ignore this warning for this project",
        vscode.CodeActionKind.QuickFix
      );
      projectAction.command = {
        command: ignoreWarningForProjectCommand,
        title: "Ignore this warning for this project",
        arguments: [document.uri, diagnostic.range.start.line, ruleId]
      };
      projectAction.diagnostics = [diagnostic];

      actions.push(localAction, projectAction);
      return actions;
    });
  }
}

function createEnvironmentCodeAction(
  document: vscode.TextDocument,
  diagnostic: vscode.Diagnostic,
  ruleId: string
): vscode.CodeAction | undefined {
  if (
    ruleId !== "generic-secret-assignment" ||
    diagnostic.range.start.line !== diagnostic.range.end.line ||
    !isSupportedEnvironmentFixFile(document.fileName)
  ) {
    return undefined;
  }

  const line = document.lineAt(diagnostic.range.start.line);
  const assignment = analyzeEnvironmentAssignment(
    line.text,
    diagnostic.range.start.character,
    diagnostic.range.end.character
  );
  if (!assignment) {
    return undefined;
  }

  const action = new vscode.CodeAction("Safe Code: Move value to .env", vscode.CodeActionKind.QuickFix);
  action.command = {
    command: moveSecretToEnvCommand,
    title: "Move value to .env",
    arguments: [document.uri, diagnostic.range, ruleId]
  };
  action.diagnostics = [diagnostic];
  return action;
}

async function moveSecretToEnvironment(uri: vscode.Uri, range: vscode.Range, ruleId: string): Promise<void> {
  if (ruleId !== "generic-secret-assignment" || range.start.line !== range.end.line) {
    return;
  }

  const document = await vscode.workspace.openTextDocument(uri);
  if (
    range.start.line < 0 ||
    range.start.line >= document.lineCount ||
    !isSupportedEnvironmentFixFile(document.fileName)
  ) {
    return;
  }

  const line = document.lineAt(range.start.line);
  const assignment = analyzeEnvironmentAssignment(line.text, range.start.character, range.end.character);
  if (!assignment) {
    return;
  }

  const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
  if (!workspaceFolder) {
    return;
  }

  const environmentStore = new EnvironmentStore(workspaceFolder);
  await environmentStore.write(assignment.environmentVariableName, assignment.secretValue);

  const sourceEdit = new vscode.WorkspaceEdit();
  sourceEdit.replace(
    uri,
    new vscode.Range(
      range.start.line,
      assignment.replacementStartCharacter,
      range.start.line,
      assignment.replacementEndCharacter
    ),
    assignment.replacement
  );
  if (!(await vscode.workspace.applyEdit(sourceEdit))) {
    throw new Error("VS Code rejected the source edit. The environment files were preserved.");
  }
}

function isSafeCodeDiagnostic(diagnostic: vscode.Diagnostic): boolean {
  return diagnostic.source === diagnosticSource && typeof diagnostic.code === "string";
}

function isEnabled(): boolean {
  return vscode.workspace.getConfiguration("safeCode").get("enabled", true);
}

function shouldScanWorkspaceOnStartup(): boolean {
  return vscode.workspace.getConfiguration("safeCode").get("scanWorkspaceOnStartup", true);
}

function getScannerOptions(): ScannerOptions {
  const configuration = vscode.workspace.getConfiguration("safeCode");
  const configuredIgnoredPaths = configuration.get<string[]>("ignoredPaths", []);
  return {
    minimumSecretLength: configuration.get("minimumSecretLength", 8),
    ignoredPaths: [...new Set([...defaultIgnoredPaths, ...configuredIgnoredPaths])]
  };
}

function createExcludeGlob(ignoredPaths: string[]): string | undefined {
  const patterns = [...new Set(ignoredPaths.map((pattern) => pattern.trim()).filter(Boolean))];
  if (patterns.length === 0) {
    return undefined;
  }

  return patterns.length === 1 ? patterns[0] : `{${patterns.join(",")}}`;
}
