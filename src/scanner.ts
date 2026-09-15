import * as vscode from "vscode";
import { SecretRuleSeverity } from "./rules";
import { defaultIgnoredPaths, scanText, shouldScanFile } from "./scannerCore";
import { utf8ByteLength, WorkspaceScanLimits } from "./workspaceScanCore";

export { defaultIgnoredPaths } from "./scannerCore";

export type ScannerOptions = WorkspaceScanLimits & {
  minimumSecretLength: number;
  ignoredPaths: string[];
};

export type DocumentScanResult =
  | {
      status: "scanned";
      byteLength: number;
      findings: SecretFinding[];
    }
  | {
      status: "oversized" | "byte-budget-exhausted";
      byteLength: number;
      findings: [];
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
  return shouldScanUri(document.uri, options);
}

export function shouldScanUri(uri: vscode.Uri, options: ScannerOptions): boolean {
  if (uri.scheme !== "file") {
    return false;
  }

  if (!vscode.workspace.getWorkspaceFolder(uri)) {
    return false;
  }

  const relativePath = vscode.workspace.asRelativePath(uri, false).replace(/\\/g, "/");
  return shouldScanFile(uri.fsPath, relativePath, options.ignoredPaths);
}

export function scanDocument(
  document: vscode.TextDocument,
  options: ScannerOptions,
  maximumAllowedBytes: number = options.maxFileSizeBytes
): DocumentScanResult {
  const text = document.getText();
  const byteLength = utf8ByteLength(text);

  if (byteLength > options.maxFileSizeBytes) {
    return { status: "oversized", byteLength, findings: [] };
  }

  if (byteLength > maximumAllowedBytes) {
    return { status: "byte-budget-exhausted", byteLength, findings: [] };
  }

  const findings = scanText(text, { minimumSecretLength: options.minimumSecretLength }).map((finding) => {
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

  return { status: "scanned", byteLength, findings };
}
