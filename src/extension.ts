import * as vscode from "vscode";
import { IgnoreStore } from "./ignoreStore";
import { defaultIgnoredPaths, scanDocument, ScannerOptions, shouldScanDocument } from "./scanner";

const diagnosticSource = "Safe Code";
const ignoreWarningCommand = "safeCode.ignoreWarning";

export function activate(context: vscode.ExtensionContext): void {
  const diagnostics = vscode.languages.createDiagnosticCollection("safe-code");
  const ignoreStore = new IgnoreStore(context.workspaceState);
  const pendingScans = new Map<string, ReturnType<typeof setTimeout>>();

  const scanNow = (document: vscode.TextDocument): void => {
    const options = getScannerOptions();

    if (!isEnabled() || !shouldScanDocument(document, options)) {
      diagnostics.delete(document.uri);
      return;
    }

    const documentDiagnostics = scanDocument(document, options)
      .filter((finding) => !ignoreStore.isIgnored(document.uri, finding.lineText, finding.ruleId))
      .map((finding) => {
        const diagnostic = new vscode.Diagnostic(finding.range, finding.message, vscode.DiagnosticSeverity.Warning);
        diagnostic.source = diagnosticSource;
        diagnostic.code = finding.ruleId;
        return diagnostic;
      });

    diagnostics.set(document.uri, documentDiagnostics);
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

  const scanOpenDocuments = (): void => {
    for (const document of vscode.workspace.textDocuments) {
      scanNow(document);
    }
  };

  context.subscriptions.push(
    diagnostics,
    vscode.workspace.onDidOpenTextDocument(queueScan),
    vscode.workspace.onDidChangeTextDocument((event) => queueScan(event.document)),
    vscode.workspace.onDidCloseTextDocument((document) => diagnostics.delete(document.uri)),
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
        diagnostics.clear();
        return;
      }

      scanOpenDocuments();
    }),
    vscode.languages.registerCodeActionsProvider(
      { scheme: "file" },
      new SafeCodeActionProvider(),
      { providedCodeActionKinds: SafeCodeActionProvider.providedCodeActionKinds }
    ),
    vscode.commands.registerCommand(ignoreWarningCommand, async (uri: vscode.Uri, line: number, ruleId: string) => {
      const document = await vscode.workspace.openTextDocument(uri);
      if (line < 0 || line >= document.lineCount) {
        return;
      }

      await ignoreStore.add(uri, document.lineAt(line).text, ruleId);
      scanNow(document);
    }),
    vscode.commands.registerCommand("safeCode.scanOpenFiles", () => {
      scanOpenDocuments();
      vscode.window.showInformationMessage("Safe Code scanned open workspace files.");
    })
  );

  scanOpenDocuments();
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
    return context.diagnostics.filter(isSafeCodeDiagnostic).map((diagnostic) => {
      const ruleId = String(diagnostic.code ?? "");
      const action = new vscode.CodeAction("Safe Code: Ignore this warning", vscode.CodeActionKind.QuickFix);
      action.command = {
        command: ignoreWarningCommand,
        title: "Ignore this warning",
        arguments: [document.uri, diagnostic.range.start.line, ruleId]
      };
      action.diagnostics = [diagnostic];
      action.isPreferred = true;
      return action;
    });
  }
}

function isSafeCodeDiagnostic(diagnostic: vscode.Diagnostic): boolean {
  return diagnostic.source === diagnosticSource && typeof diagnostic.code === "string";
}

function isEnabled(): boolean {
  return vscode.workspace.getConfiguration("safeCode").get("enabled", true);
}

function getScannerOptions(): ScannerOptions {
  const configuration = vscode.workspace.getConfiguration("safeCode");
  return {
    minimumSecretLength: configuration.get("minimumSecretLength", 8),
    ignoredPaths: configuration.get("ignoredPaths", defaultIgnoredPaths)
  };
}
