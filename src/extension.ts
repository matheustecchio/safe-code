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
import {
  getProjectIgnoreFileErrorMessage,
  projectIgnoreConfigFileName,
  ProjectIgnoreStore
} from "./projectIgnoreStore";
import { defaultIgnoredPaths, scanDocument, ScannerOptions, shouldScanDocument, shouldScanUri } from "./scanner";
import { supportedWorkspaceFileGlob } from "./scannerCore";
import {
  BoundedScanQueue,
  DEFAULT_MAX_FILE_SIZE_BYTES,
  DEFAULT_MAX_WORKSPACE_SCAN_BYTES,
  DEFAULT_MAX_WORKSPACE_SCAN_FILES,
  getDiscoveryMaxResults,
  getStaleDiagnosticKeys,
  isPositiveInteger,
  WorkspaceScanBudget
} from "./workspaceScanCore";

const diagnosticSource = "Safe Code";
const ignoreWarningCommand = "safeCode.ignoreWarning";
const ignoreWarningForProjectCommand = "safeCode.ignoreWarningForProject";
const moveSecretToEnvCommand = "safeCode.moveSecretToEnv";
const scanWorkspaceCommand = "safeCode.scanWorkspace";

type WorkspaceScanPartialReason = "file-limit" | "byte-limit" | "scan-state-changed";

export type WorkspaceScanResult = {
  cancelled: boolean;
  failedFiles: number;
  findings: number;
  oversizedFiles: number;
  partial: boolean;
  partialReason?: WorkspaceScanPartialReason;
  scannedBytes: number;
  scannedFiles: number;
};

type ScanNowResult = {
  byteLength: number;
  findings: number;
  status: "scanned" | "oversized" | "byte-budget-exhausted" | "skipped" | "stale";
};

type PendingScan = {
  document?: vscode.TextDocument;
  uri: vscode.Uri;
};

type FileScanOutcome = "scanned" | "oversized" | "failed" | "skipped" | "stale";

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const diagnostics = vscode.languages.createDiagnosticCollection("safe-code");
  const output = vscode.window.createOutputChannel("Safe Code");
  const ignoreStore = new IgnoreStore(context.workspaceState);
  const projectIgnoreStore = new ProjectIgnoreStore(output);
  const environmentMigrationCoordinator = new EnvironmentMigrationCoordinator();
  const pendingScans = new BoundedScanQueue<PendingScan>();
  const diagnosticUris = new Map<string, vscode.Uri>();
  const workspaceScanOpeningUris = new Set<string>();
  let pendingScanTimer: ReturnType<typeof setTimeout> | undefined;
  let pendingScanDrainInProgress = false;
  let overflowRescanInProgress = false;
  let scanGeneration = 0;
  let workspaceScanInProgress = false;
  let workspaceRescanRequested = false;

  await projectIgnoreStore.reloadAll();

  const deleteDiagnostic = (uri: vscode.Uri): void => {
    diagnostics.delete(uri);
    diagnosticUris.delete(uri.toString());
  };

  const scanNow = (
    document: vscode.TextDocument,
    options = getScannerOptions(),
    maximumAllowedBytes = options.maxFileSizeBytes,
    expectedGeneration = scanGeneration
  ): ScanNowResult => {
    const key = document.uri.toString();

    if (expectedGeneration !== scanGeneration) {
      return { status: "stale", byteLength: 0, findings: 0 };
    }

    if (!isEnabled() || !shouldScanDocument(document, options)) {
      deleteDiagnostic(document.uri);
      return { status: "skipped", byteLength: 0, findings: 0 };
    }

    const scanResult = scanDocument(document, options, maximumAllowedBytes);
    if (scanResult.status === "oversized") {
      deleteDiagnostic(document.uri);
      return { status: "oversized", byteLength: scanResult.byteLength, findings: 0 };
    }

    if (scanResult.status === "byte-budget-exhausted") {
      return { status: "byte-budget-exhausted", byteLength: scanResult.byteLength, findings: 0 };
    }

    if (expectedGeneration !== scanGeneration) {
      return { status: "stale", byteLength: scanResult.byteLength, findings: 0 };
    }

    const documentDiagnostics = scanResult.findings
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

    return {
      status: "scanned",
      byteLength: scanResult.byteLength,
      findings: documentDiagnostics.length
    };
  };

  const isUriScanCurrent = (uri: vscode.Uri, version: number): boolean =>
    pendingScans.isCurrent(uri.toString(), version);

  const removeDiagnostics = (uri: vscode.Uri, includeDescendants = false): void => {
    if (includeDescendants) {
      pendingScans.removeWhere((key) => isSameOrDescendantUri(uri, vscode.Uri.parse(key), true));
    } else {
      pendingScans.remove(uri.toString());
    }
    deleteDiagnostic(uri);

    if (includeDescendants) {
      for (const [key, diagnosticUri] of diagnosticUris) {
        if (isSameOrDescendantUri(uri, diagnosticUri, true)) {
          deleteDiagnostic(diagnosticUri);
          diagnosticUris.delete(key);
        }
      }
    }
  };

  const getOpenDocument = (uri: vscode.Uri): vscode.TextDocument | undefined => {
    const key = uri.toString();
    return vscode.workspace.textDocuments.find((document) => document.uri.toString() === key);
  };

  const scanUri = async (
    uri: vscode.Uri,
    expectedUriVersion: number,
    options = getScannerOptions(),
    expectedGeneration = scanGeneration
  ): Promise<FileScanOutcome> => {
    if (expectedGeneration !== scanGeneration || !isUriScanCurrent(uri, expectedUriVersion)) {
      return "stale";
    }

    if (!isEnabled() || !shouldScanUri(uri, options)) {
      deleteDiagnostic(uri);
      return "skipped";
    }

    try {
      const openDocument = getOpenDocument(uri);
      if (openDocument) {
        return toFileScanOutcome(scanNow(openDocument, options, options.maxFileSizeBytes, expectedGeneration));
      }

      const stat = await vscode.workspace.fs.stat(uri);
      if (expectedGeneration !== scanGeneration || !isUriScanCurrent(uri, expectedUriVersion)) {
        return "stale";
      }

      if ((stat.type & vscode.FileType.File) === 0) {
        deleteDiagnostic(uri);
        return "skipped";
      }

      if (stat.size > options.maxFileSizeBytes) {
        deleteDiagnostic(uri);
        return "oversized";
      }

      const documentOpenedDuringStat = getOpenDocument(uri);
      if (documentOpenedDuringStat) {
        return toFileScanOutcome(
          scanNow(documentOpenedDuringStat, options, options.maxFileSizeBytes, expectedGeneration)
        );
      }

      const key = uri.toString();
      workspaceScanOpeningUris.add(key);
      let document: vscode.TextDocument;
      try {
        document = await vscode.workspace.openTextDocument(uri);
      } finally {
        workspaceScanOpeningUris.delete(key);
      }

      if (expectedGeneration !== scanGeneration || !isUriScanCurrent(uri, expectedUriVersion)) {
        return "stale";
      }

      return toFileScanOutcome(scanNow(document, options, options.maxFileSizeBytes, expectedGeneration));
    } catch {
      if (expectedGeneration !== scanGeneration || !isUriScanCurrent(uri, expectedUriVersion)) {
        return "stale";
      }

      deleteDiagnostic(uri);
      return "failed";
    }
  };

  const scanPendingJob = async (job: PendingScan, version: number): Promise<FileScanOutcome> => {
    const options = getScannerOptions();
    const expectedGeneration = scanGeneration;
    if (!isUriScanCurrent(job.uri, version)) {
      return "stale";
    }

    if (job.document) {
      return toFileScanOutcome(scanNow(job.document, options, options.maxFileSizeBytes, expectedGeneration));
    }

    return scanUri(job.uri, version, options, expectedGeneration);
  };

  const drainPendingScans = async (): Promise<void> => {
    if (pendingScanDrainInProgress) {
      return;
    }

    pendingScanDrainInProgress = true;
    let failedFiles = 0;
    let oversizedFiles = 0;

    try {
      let queuedScan = pendingScans.shift();
      while (queuedScan) {
        try {
          const outcome = await scanPendingJob(queuedScan.value, queuedScan.version);
          if (outcome === "failed") {
            failedFiles += 1;
          } else if (outcome === "oversized") {
            oversizedFiles += 1;
          }
        } catch {
          failedFiles += 1;
        } finally {
          pendingScans.release(queuedScan.key, queuedScan.version);
        }

        queuedScan = pendingScans.shift();
      }
    } finally {
      const overflowed = pendingScans.consumeOverflow();
      pendingScanDrainInProgress = false;

      if (oversizedFiles > 0 || failedFiles > 0 || overflowed) {
        const overflowSuffix = overflowed ? " A silent workspace rescan was requested after queue overflow." : "";
        output.appendLine(
          `Safe Code file-event batch skipped ${oversizedFiles} oversized files and could not read ${failedFiles} files.${overflowSuffix}`
        );
      }

      if (pendingScans.size > 0) {
        schedulePendingScanDrain();
      }

      if (overflowed) {
        void requestOverflowRescan();
      }
    }
  };

  const schedulePendingScanDrain = (): void => {
    if (pendingScanDrainInProgress) {
      return;
    }

    if (pendingScanTimer) {
      return;
    }

    pendingScanTimer = setTimeout(() => {
      pendingScanTimer = undefined;
      void drainPendingScans();
    }, 250);
  };

  const queuePendingScan = (job: PendingScan): void => {
    pendingScans.enqueue(job.uri.toString(), job);
    schedulePendingScanDrain();
  };

  const queueScan = (document: vscode.TextDocument): void => {
    const key = document.uri.toString();
    if (workspaceScanOpeningUris.has(key)) {
      return;
    }

    const options = getScannerOptions();
    if (!isEnabled() || !shouldScanDocument(document, options)) {
      removeDiagnostics(document.uri);
      return;
    }

    queuePendingScan({ document, uri: document.uri });
  };

  const queueUriScan = (uri: vscode.Uri): void => {
    const options = getScannerOptions();
    if (!isEnabled() || !shouldScanUri(uri, options)) {
      removeDiagnostics(uri);
      return;
    }

    queuePendingScan({ uri });
  };

  const requestOverflowRescan = async (): Promise<void> => {
    if (overflowRescanInProgress) {
      workspaceRescanRequested = true;
      return;
    }

    overflowRescanInProgress = true;
    try {
      await scanWorkspace(false);
    } finally {
      overflowRescanInProgress = false;
      if (workspaceRescanRequested && !workspaceScanInProgress) {
        workspaceRescanRequested = false;
        void requestOverflowRescan();
      }
    }
  };

  const clearPendingScans = (): void => {
    pendingScans.clear();
    if (pendingScanTimer) {
      clearTimeout(pendingScanTimer);
      pendingScanTimer = undefined;
    }
  };

  const invalidateScanState = (): void => {
    scanGeneration += 1;
    clearPendingScans();
  };

  const scanOpenDocuments = (): { oversizedFiles: number; scannedFiles: number } => {
    const options = getScannerOptions();
    const expectedGeneration = scanGeneration;
    let oversizedFiles = 0;
    let scannedFiles = 0;

    for (const document of vscode.workspace.textDocuments) {
      const result = scanNow(document, options, options.maxFileSizeBytes, expectedGeneration);
      if (result.status === "oversized") {
        oversizedFiles += 1;
      } else if (result.status === "scanned") {
        scannedFiles += 1;
      }
    }

    if (oversizedFiles > 0) {
      output.appendLine(`Safe Code skipped ${oversizedFiles} oversized open files.`);
    }

    return { oversizedFiles, scannedFiles };
  };

  const clearTrackedDiagnostics = (): void => {
    diagnostics.clear();
    diagnosticUris.clear();
  };

  async function scanWorkspace(interactive: boolean): Promise<WorkspaceScanResult | undefined> {
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
          const expectedGeneration = scanGeneration;
          const budget = new WorkspaceScanBudget(options);
          const result = createEmptyWorkspaceScanResult();
          const previousDiagnosticUris = new Map(diagnosticUris);
          const currentDiagnosticKeys = new Set<string>();
          let discoveredUris: vscode.Uri[];
          try {
            discoveredUris = await vscode.workspace.findFiles(
              supportedWorkspaceFileGlob,
              createExcludeGlob(options.ignoredPaths),
              getDiscoveryMaxResults(options.maxWorkspaceScanFiles),
              token
            );
          } catch (error) {
            if (token.isCancellationRequested) {
              result.cancelled = true;
              return result;
            }
            throw error;
          }

          if (expectedGeneration !== scanGeneration) {
            result.partial = true;
            result.partialReason = "scan-state-changed";
            return result;
          }

          const discoveryWasTruncated = discoveredUris.length > options.maxWorkspaceScanFiles;
          if (discoveryWasTruncated) {
            result.partial = true;
            result.partialReason = "file-limit";
          }

          const candidateUris = discoveredUris
            .filter((uri) => shouldScanUri(uri, options))
            .sort((left, right) => left.toString().localeCompare(right.toString()))
            .slice(0, options.maxWorkspaceScanFiles);
          let processedFiles = 0;

          for (const uri of candidateUris) {
            if (token.isCancellationRequested) {
              break;
            }

            if (expectedGeneration !== scanGeneration) {
              result.partial = true;
              result.partialReason = "scan-state-changed";
              break;
            }

            const key = uri.toString();
            const expectedUriVersion = pendingScans.begin(key);
            try {
              let document = getOpenDocument(uri);
              if (!document) {
                const stat = await vscode.workspace.fs.stat(uri);
                if (token.isCancellationRequested) {
                  break;
                }

                if (expectedGeneration !== scanGeneration) {
                  result.partial = true;
                  result.partialReason = "scan-state-changed";
                  break;
                }

                if (!isUriScanCurrent(uri, expectedUriVersion)) {
                  currentDiagnosticKeys.add(key);
                  processedFiles += 1;
                  reportWorkspaceProgress(progress, processedFiles, candidateUris.length);
                  continue;
                }

                if ((stat.type & vscode.FileType.File) === 0) {
                  deleteDiagnostic(uri);
                  processedFiles += 1;
                  reportWorkspaceProgress(progress, processedFiles, candidateUris.length);
                  continue;
                }

                const preflightDecision = budget.check(stat.size);
                if (preflightDecision === "oversized") {
                  deleteDiagnostic(uri);
                  result.oversizedFiles += 1;
                  processedFiles += 1;
                  reportWorkspaceProgress(progress, processedFiles, candidateUris.length);
                  continue;
                }

                if (preflightDecision === "file-budget-exhausted") {
                  result.partial = true;
                  result.partialReason = "file-limit";
                  break;
                }

                if (preflightDecision === "byte-budget-exhausted") {
                  result.partial = true;
                  result.partialReason = "byte-limit";
                  break;
                }

                document = getOpenDocument(uri);
                if (!document) {
                  workspaceScanOpeningUris.add(key);
                  try {
                    document = await vscode.workspace.openTextDocument(uri);
                  } finally {
                    workspaceScanOpeningUris.delete(key);
                  }
                }
              } else {
                const fileCountDecision = budget.check(0);
                if (fileCountDecision === "file-budget-exhausted") {
                  result.partial = true;
                  result.partialReason = "file-limit";
                  break;
                }
              }

              if (token.isCancellationRequested) {
                break;
              }

              if (!isUriScanCurrent(uri, expectedUriVersion)) {
                currentDiagnosticKeys.add(key);
                processedFiles += 1;
                reportWorkspaceProgress(progress, processedFiles, candidateUris.length);
                continue;
              }

              const fileResult = scanNow(document, options, budget.remainingBytes, expectedGeneration);
              if (fileResult.status === "stale") {
                result.partial = true;
                result.partialReason = "scan-state-changed";
                break;
              }

              if (fileResult.status === "byte-budget-exhausted") {
                result.partial = true;
                result.partialReason = "byte-limit";
                break;
              }

              if (fileResult.status === "oversized") {
                result.oversizedFiles += 1;
                processedFiles += 1;
                reportWorkspaceProgress(progress, processedFiles, candidateUris.length);
                continue;
              }

              if (fileResult.status !== "scanned") {
                processedFiles += 1;
                reportWorkspaceProgress(progress, processedFiles, candidateUris.length);
                continue;
              }

              const budgetDecision = budget.accept(fileResult.byteLength);
              if (budgetDecision !== "accepted") {
                result.partial = true;
                result.partialReason = budgetDecision === "file-budget-exhausted" ? "file-limit" : "byte-limit";
                break;
              }

              result.findings += fileResult.findings;
              if (fileResult.findings > 0) {
                currentDiagnosticKeys.add(key);
              }
              result.scannedFiles = budget.acceptedFiles;
              result.scannedBytes = budget.acceptedBytes;
            } catch {
              if (!isUriScanCurrent(uri, expectedUriVersion)) {
                currentDiagnosticKeys.add(key);
                processedFiles += 1;
                reportWorkspaceProgress(progress, processedFiles, candidateUris.length);
                continue;
              }

              result.failedFiles += 1;
            } finally {
              pendingScans.release(key, expectedUriVersion);
            }

            processedFiles += 1;
            reportWorkspaceProgress(progress, processedFiles, candidateUris.length);
          }

          result.cancelled = token.isCancellationRequested;
          if (expectedGeneration !== scanGeneration) {
            result.partial = true;
            result.partialReason = "scan-state-changed";
          }

          for (const key of getStaleDiagnosticKeys(
            previousDiagnosticUris.keys(),
            currentDiagnosticKeys,
            result.cancelled,
            result.partial
          )) {
            const uri = previousDiagnosticUris.get(key);
            if (uri) {
              deleteDiagnostic(uri);
            }
          }

          return result;
        }
      );

      output.appendLine(formatWorkspaceScanOutput(result));

      if (result.cancelled) {
        if (interactive) {
          void vscode.window.showInformationMessage(
            `Safe Code workspace scan cancelled after ${result.scannedFiles} files. Processed results were kept.`
          );
        }
        return result;
      }

      if (interactive && result.partial) {
        void vscode.window.showWarningMessage(formatPartialWorkspaceScanMessage(result));
      } else if (interactive) {
        void vscode.window.showInformationMessage(
          `Safe Code scanned ${result.scannedFiles} files and found ${result.findings} warnings.${formatWorkspaceSkipSuffix(result)}`
        );
      }

      return result;
    } catch (error) {
      const message = `Safe Code workspace scan failed: ${String(error)}`;
      output.appendLine(message);
      if (interactive) {
        void vscode.window.showErrorMessage(message);
      }
      return undefined;
    } finally {
      workspaceScanInProgress = false;
      if (workspaceRescanRequested) {
        workspaceRescanRequested = false;
        void scanWorkspace(false);
      }
    }
  }

  const refreshProjectConfiguration = async (uri: vscode.Uri): Promise<void> => {
    invalidateScanState();
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
    new vscode.Disposable(clearPendingScans),
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

      invalidateScanState();
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
      invalidateScanState();
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
          const message = `Safe Code could not update ${projectIgnoreConfigFileName}. ${getProjectIgnoreFileErrorMessage(
            error,
            "write-failed"
          )}`;
          output.appendLine(message);
          void vscode.window.showErrorMessage(message);
        }
      }
    ),
    vscode.commands.registerCommand("safeCode.scanOpenFiles", () => {
      const result = scanOpenDocuments();
      const oversizedSuffix =
        result.oversizedFiles > 0 ? ` ${result.oversizedFiles} oversized files were skipped.` : "";
      void vscode.window.showInformationMessage(
        `Safe Code scanned ${result.scannedFiles} open workspace files.${oversizedSuffix}`
      );
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

function createEmptyWorkspaceScanResult(): WorkspaceScanResult {
  return {
    cancelled: false,
    failedFiles: 0,
    findings: 0,
    oversizedFiles: 0,
    partial: false,
    scannedBytes: 0,
    scannedFiles: 0
  };
}

function toFileScanOutcome(result: ScanNowResult): FileScanOutcome {
  switch (result.status) {
    case "scanned":
      return "scanned";
    case "oversized":
      return "oversized";
    case "stale":
      return "stale";
    case "byte-budget-exhausted":
    case "skipped":
      return "skipped";
  }
}

function reportWorkspaceProgress(
  progress: vscode.Progress<{ increment?: number; message?: string }>,
  processedFiles: number,
  totalFiles: number
): void {
  progress.report({
    message: `${processedFiles} of ${totalFiles} files`,
    increment: totalFiles > 0 ? 100 / totalFiles : undefined
  });
}

function formatWorkspaceScanOutput(result: WorkspaceScanResult): string {
  const status = result.cancelled ? "cancelled" : result.partial ? "partial" : "complete";
  const reason = result.partialReason ? ` (${result.partialReason})` : "";
  return `Safe Code workspace scan ${status}${reason}: scanned ${result.scannedFiles} files / ${result.scannedBytes} UTF-8 bytes, found ${result.findings} warnings, skipped ${result.oversizedFiles} oversized files, and could not read ${result.failedFiles} files.`;
}

function formatPartialWorkspaceScanMessage(result: WorkspaceScanResult): string {
  const reason =
    result.partialReason === "file-limit"
      ? "the workspace file limit"
      : result.partialReason === "byte-limit"
        ? "the workspace byte limit"
        : "scan settings or workspace state changed";

  return `Safe Code scanned ${result.scannedFiles} files and stopped at ${reason}. Processed results were kept and unvisited diagnostics were left unchanged.${formatWorkspaceSkipSuffix(result)}`;
}

function formatWorkspaceSkipSuffix(result: WorkspaceScanResult): string {
  const details: string[] = [];
  if (result.oversizedFiles > 0) {
    details.push(`${result.oversizedFiles} oversized files were skipped.`);
  }
  if (result.failedFiles > 0) {
    details.push(`${result.failedFiles} files could not be read.`);
  }

  return details.length > 0 ? ` ${details.join(" ")}` : "";
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
    maxFileSizeBytes: getPositiveIntegerSetting(configuration, "maxFileSizeBytes", DEFAULT_MAX_FILE_SIZE_BYTES),
    maxWorkspaceScanFiles: getPositiveIntegerSetting(
      configuration,
      "maxWorkspaceScanFiles",
      DEFAULT_MAX_WORKSPACE_SCAN_FILES
    ),
    maxWorkspaceScanBytes: getPositiveIntegerSetting(
      configuration,
      "maxWorkspaceScanBytes",
      DEFAULT_MAX_WORKSPACE_SCAN_BYTES
    ),
    ignoredPaths: [...new Set([...defaultIgnoredPaths, ...configuredIgnoredPaths])]
  };
}

function getPositiveIntegerSetting(
  configuration: vscode.WorkspaceConfiguration,
  key: string,
  defaultValue: number
): number {
  const value = configuration.get<unknown>(key);
  return isPositiveInteger(value) ? value : defaultValue;
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
