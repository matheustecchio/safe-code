import * as path from "path";
import * as vscode from "vscode";
import {
  analyzeEnvironmentAssignment,
  EnvironmentAssignment,
  isSupportedEnvironmentFixFile
} from "./environmentFixCore";
import {
  AppliedEnvironmentMigrationError,
  EnvironmentMigrationCoordinator,
  EnvironmentMigrationError,
  EnvironmentMigrationMutation,
  EnvironmentMigrationStep,
  getEnvironmentMigrationMessage
} from "./environmentMigrationCore";
import {
  assertSafeMigrationSource,
  EnvironmentStore,
  getEnvironmentWorkspaceIdentity
} from "./environmentStore";
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
  const environmentMigrationCoordinator = new EnvironmentMigrationCoordinator();
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
      pendingScans.delete(key);
    }

    if (!isEnabled() || !shouldScanDocument(document, getScannerOptions())) {
      diagnostics.delete(document.uri);
      diagnosticUris.delete(key);
      return;
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
      pendingScans.delete(key);
    }

    if (!isEnabled() || !shouldScanUri(uri, getScannerOptions())) {
      diagnostics.delete(uri);
      diagnosticUris.delete(key);
      return;
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
      const stat = await vscode.workspace.fs.stat(uri);
      if ((stat.type & vscode.FileType.File) === 0) {
        removeDiagnostics(uri);
        return;
      }
      const document = await vscode.workspace.openTextDocument(uri);
      scanNow(document, options);
    } catch (error) {
      removeDiagnostics(uri);
      console.warn(`Safe Code could not scan ${uri.fsPath}: ${String(error)}`);
    }
  };

  const removeDiagnostics = (uri: vscode.Uri, includeDescendants = false): void => {
    for (const [key, pendingScan] of pendingScans) {
      const pendingUri = vscode.Uri.parse(key);
      if (isSameOrDescendantUri(uri, pendingUri, includeDescendants)) {
        clearTimeout(pendingScan);
        pendingScans.delete(key);
      }
    }

    diagnostics.delete(uri);
    diagnosticUris.delete(uri.toString());
    if (includeDescendants) {
      for (const [key, diagnosticUri] of diagnosticUris) {
        if (isSameOrDescendantUri(uri, diagnosticUri, true)) {
          diagnostics.delete(diagnosticUri);
          diagnosticUris.delete(key);
        }
      }
    }
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

    removeDiagnostics(uri, true);
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
      async (uri: vscode.Uri, range: vscode.Range, ruleId: string, expectedVersion: number) => {
        try {
          await vscode.window.withProgress(
            {
              cancellable: true,
              location: vscode.ProgressLocation.Notification,
              title: "Safe Code: Moving value to .env"
            },
            async (_progress, token) => {
              await moveSecretToEnvironment(
                uri,
                range,
                ruleId,
                expectedVersion,
                token,
                environmentMigrationCoordinator
              );
            }
          );
        } catch (error) {
          const message = getEnvironmentMigrationMessage(error);
          output.appendLine(message);
          if (error instanceof EnvironmentMigrationError && error.code === "cancelled") {
            void vscode.window.showInformationMessage(message);
          } else {
            void vscode.window.showErrorMessage(message);
          }
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
    arguments: [document.uri, diagnostic.range, ruleId, document.version]
  };
  action.diagnostics = [diagnostic];
  return action;
}

async function moveSecretToEnvironment(
  uri: vscode.Uri,
  range: vscode.Range,
  ruleId: string,
  expectedVersion: number,
  cancellation: vscode.CancellationToken,
  coordinator: EnvironmentMigrationCoordinator
): Promise<void> {
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
  if (
    ruleId !== "generic-secret-assignment" ||
    range.start.line !== range.end.line ||
    uri.scheme !== "file" ||
    workspaceFolder?.uri.scheme !== "file" ||
    !Number.isSafeInteger(expectedVersion)
  ) {
    throw new EnvironmentMigrationError("invalid-source");
  }

  const workspaceIdentity = await getEnvironmentWorkspaceIdentity(workspaceFolder.uri.fsPath);
  const environmentStore = new EnvironmentStore(
    workspaceFolder.uri.fsPath,
    {},
    workspaceIdentity.identity
  );
  let source: PreparedSourceMigration | undefined;

  await coordinator.run(
    workspaceIdentity.key,
    {
      prepare: async () => {
        source = await prepareSourceMigration(uri, range, expectedVersion, workspaceFolder.uri.fsPath);
        assertEnvironmentTargetsAreNotDirty(workspaceFolder);
        await environmentStore.prepare(
          source.assignment.environmentVariableName,
          source.assignment.secretValue
        );
      },
      beforeStep: async (step) => {
        if (!source) {
          throw new EnvironmentMigrationError("invalid-source");
        }
        assertEnvironmentTargetsAreNotDirty(workspaceFolder);
        await validatePreparedSource(source, false);
        await environmentStore.beforeStep(step);
      },
      apply: async (step) => {
        if (!source) {
          throw new EnvironmentMigrationError("invalid-source");
        }
        if (step === "source") {
          assertEnvironmentTargetsAreNotDirty(workspaceFolder);
          await environmentStore.beforeStep("source");
          return await applySourceMigration(source);
        }
        return await environmentStore.apply(step);
      },
      verify: async () => {
        if (!source) {
          throw new EnvironmentMigrationError("invalid-source");
        }
        assertEnvironmentTargetsAreNotDirty(workspaceFolder);
        await environmentStore.verify();
        await validatePreparedSource(source, true);
      }
    },
    cancellation
  );
}

type PreparedSourceMigration = {
  afterLineText: string;
  afterVersion?: number;
  assignment: EnvironmentAssignment;
  beforeLineText: string;
  beforeVersion: number;
  document: vscode.TextDocument;
  range: vscode.Range;
  uri: vscode.Uri;
  workspaceRoot: string;
};

async function prepareSourceMigration(
  uri: vscode.Uri,
  range: vscode.Range,
  expectedVersion: number,
  workspaceRoot: string
): Promise<PreparedSourceMigration> {
  await assertSafeMigrationSource(workspaceRoot, uri.fsPath);
  const document = await vscode.workspace.openTextDocument(uri);
  if (
    document.version !== expectedVersion ||
    range.start.line < 0 ||
    range.start.line >= document.lineCount ||
    !isSupportedEnvironmentFixFile(document.fileName)
  ) {
    throw new EnvironmentMigrationError("invalid-source");
  }

  const beforeLineText = document.lineAt(range.start.line).text;
  const assignment = analyzeEnvironmentAssignment(
    beforeLineText,
    range.start.character,
    range.end.character
  );
  if (!assignment) {
    throw new EnvironmentMigrationError("invalid-source");
  }

  return {
    afterLineText:
      beforeLineText.slice(0, assignment.replacementStartCharacter) +
      assignment.replacement +
      beforeLineText.slice(assignment.replacementEndCharacter),
    assignment,
    beforeLineText,
    beforeVersion: expectedVersion,
    document,
    range,
    uri,
    workspaceRoot
  };
}

async function validatePreparedSource(source: PreparedSourceMigration, expectApplied: boolean): Promise<void> {
  await assertSafeMigrationSource(source.workspaceRoot, source.uri.fsPath);
  const document = await vscode.workspace.openTextDocument(source.uri);
  const expectedVersion = expectApplied ? source.afterVersion : source.beforeVersion;
  const expectedLineText = expectApplied ? source.afterLineText : source.beforeLineText;
  if (
    document !== source.document ||
    document.version !== expectedVersion ||
    source.range.start.line < 0 ||
    source.range.start.line >= document.lineCount ||
    document.lineAt(source.range.start.line).text !== expectedLineText
  ) {
    throw new EnvironmentMigrationError("concurrent-change");
  }

  if (!expectApplied) {
    const assignment = analyzeEnvironmentAssignment(
      expectedLineText,
      source.range.start.character,
      source.range.end.character
    );
    if (
      !assignment ||
      assignment.environmentVariableName !== source.assignment.environmentVariableName ||
      assignment.secretValue !== source.assignment.secretValue ||
      assignment.replacementStartCharacter !== source.assignment.replacementStartCharacter ||
      assignment.replacementEndCharacter !== source.assignment.replacementEndCharacter
    ) {
      throw new EnvironmentMigrationError("invalid-source");
    }
  }
}

async function applySourceMigration(source: PreparedSourceMigration): Promise<EnvironmentMigrationMutation> {
  await validatePreparedSource(source, false);
  const replacementRange = new vscode.Range(
    source.range.start.line,
    source.assignment.replacementStartCharacter,
    source.range.start.line,
    source.assignment.replacementEndCharacter
  );
  const sourceEdit = new vscode.WorkspaceEdit();
  sourceEdit.replace(source.uri, replacementRange, source.assignment.replacement);

  try {
    const accepted = await vscode.workspace.applyEdit(sourceEdit);
    if (!accepted) {
      throw new EnvironmentMigrationError("source-edit-failed");
    }
  } catch (error) {
    const mutation = detectAppliedSourceMutation(source);
    if (mutation) {
      throw new AppliedEnvironmentMigrationError(
        mutation,
        new EnvironmentMigrationError("source-edit-failed", { cause: error })
      );
    }
    if (source.document.version !== source.beforeVersion) {
      throw new AppliedEnvironmentMigrationError(
        createUnrecoverableSourceMutation(),
        new EnvironmentMigrationError("rollback-failed", { cause: error })
      );
    }
    if (error instanceof EnvironmentMigrationError) {
      throw error;
    }
    throw new EnvironmentMigrationError("source-edit-failed", { cause: error });
  }

  const mutation = detectAppliedSourceMutation(source);
  if (!mutation) {
    if (source.document.version !== source.beforeVersion) {
      throw new AppliedEnvironmentMigrationError(
        createUnrecoverableSourceMutation(),
        new EnvironmentMigrationError("rollback-failed")
      );
    }
    throw new EnvironmentMigrationError("source-edit-failed");
  }
  return mutation;
}

function createUnrecoverableSourceMutation(): EnvironmentMigrationMutation {
  return {
    step: "source",
    rollback: async () => {
      throw new EnvironmentMigrationError("rollback-failed");
    },
    verify: async () => {
      throw new EnvironmentMigrationError("rollback-failed");
    }
  };
}

function detectAppliedSourceMutation(source: PreparedSourceMigration): EnvironmentMigrationMutation | undefined {
  if (
    source.range.start.line >= source.document.lineCount ||
    source.document.lineAt(source.range.start.line).text !== source.afterLineText ||
    source.document.version === source.beforeVersion
  ) {
    return undefined;
  }

  source.afterVersion = source.document.version;
  return createSourceMutation(source);
}

function createSourceMutation(source: PreparedSourceMigration): EnvironmentMigrationMutation {
  const quotedValue = source.beforeLineText.slice(
    source.assignment.replacementStartCharacter,
    source.assignment.replacementEndCharacter
  );

  return {
    step: "source",
    rollback: async () => {
      await validatePreparedSource(source, true);
      const inverseEdit = new vscode.WorkspaceEdit();
      inverseEdit.replace(
        source.uri,
        new vscode.Range(
          source.range.start.line,
          source.assignment.replacementStartCharacter,
          source.range.start.line,
          source.assignment.replacementStartCharacter + source.assignment.replacement.length
        ),
        quotedValue
      );
      if (!(await vscode.workspace.applyEdit(inverseEdit))) {
        throw new EnvironmentMigrationError("rollback-failed");
      }
      if (source.document.lineAt(source.range.start.line).text !== source.beforeLineText) {
        throw new EnvironmentMigrationError("rollback-failed");
      }
    },
    verify: async () => {
      await validatePreparedSource(source, true);
    }
  };
}

function assertEnvironmentTargetsAreNotDirty(workspaceFolder: vscode.WorkspaceFolder): void {
  const protectedUris = new Set(
    [".gitignore", ".env", ".env.example"].map((name) => vscode.Uri.joinPath(workspaceFolder.uri, name).toString())
  );
  if (vscode.workspace.textDocuments.some((document) => document.isDirty && protectedUris.has(document.uri.toString()))) {
    throw new EnvironmentMigrationError("unsafe-target");
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

function isSameOrDescendantUri(
  parent: vscode.Uri,
  candidate: vscode.Uri,
  includeDescendants: boolean
): boolean {
  if (candidate.toString() === parent.toString()) {
    return true;
  }
  if (
    !includeDescendants ||
    parent.scheme !== candidate.scheme ||
    parent.authority !== candidate.authority
  ) {
    return false;
  }

  const relativePath = path.relative(parent.fsPath, candidate.fsPath);
  return relativePath.length > 0 &&
    relativePath !== ".." &&
    !relativePath.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relativePath);
}
