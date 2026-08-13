import * as vscode from "vscode";
import { SecretRuleSeverity } from "./rules";
import { defaultIgnoredPaths, scanText, shouldScanFile } from "./scannerCore";

export { defaultIgnoredPaths } from "./scannerCore";

export type ScannerOptions = {
  minimumSecretLength: number;
  ignoredPaths: string[];
};

export type SecretFinding = {
  ruleId: string;
  ruleName: string;
  severity: SecretRuleSeverity;
  message: string;
  value: string;
  range: vscode.Range;
  lineText: string;
};

export function shouldScanDocument(document: vscode.TextDocument, options: ScannerOptions): boolean {
  if (document.uri.scheme !== "file") {
    return false;
  }

  if (!vscode.workspace.getWorkspaceFolder(document.uri)) {
    return false;
  }

  const relativePath = vscode.workspace.asRelativePath(document.uri, false).replace(/\\/g, "/");
  return shouldScanFile(document.fileName, relativePath, options.ignoredPaths);
}

export function scanDocument(document: vscode.TextDocument, options: ScannerOptions): SecretFinding[] {
  if (!shouldScanDocument(document, options)) {
    return [];
  }

  return scanText(document.getText(), { minimumSecretLength: options.minimumSecretLength }).map((finding) => {
    return {
      ruleId: finding.ruleId,
      ruleName: finding.ruleName,
      severity: finding.severity,
      message: finding.message,
      value: finding.value,
      range: new vscode.Range(document.positionAt(finding.startOffset), document.positionAt(finding.endOffset)),
      lineText: finding.lineText
    };
  });
}
