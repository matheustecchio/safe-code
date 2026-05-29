import * as path from "path";
import * as vscode from "vscode";
import { secretRules, SecretRule, SecretRuleSeverity } from "./rules";

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

export const defaultIgnoredPaths = [
  "**/node_modules/**",
  "**/.git/**",
  "**/dist/**",
  "**/build/**",
  "**/coverage/**",
  "**/vendor/**",
  "**/target/**",
  "**/.cache/**"
];

const supportedExtensions = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".py",
  ".go",
  ".java",
  ".cs",
  ".php",
  ".rb",
  ".json",
  ".yaml",
  ".yml",
  ".toml",
  ".ini",
  ".md"
]);

const fakeExactValues = new Set([
  "example",
  "sample",
  "test",
  "fake",
  "dummy",
  "changeme",
  "change-me",
  "your-api-key",
  "your-token",
  "xxx",
  "xxxx",
  "xxxxx",
  "123456",
  "password"
]);

const fakeValueFragments = [
  "your-api-key",
  "your_api_key",
  "your-token",
  "your_token",
  "replace-me",
  "replace_me",
  "changeme",
  "change-me"
];

const globCache = new Map<string, RegExp>();

export function shouldScanDocument(document: vscode.TextDocument, options: ScannerOptions): boolean {
  if (document.uri.scheme !== "file") {
    return false;
  }

  if (!vscode.workspace.getWorkspaceFolder(document.uri)) {
    return false;
  }

  if (!isSupportedFile(document.fileName)) {
    return false;
  }

  const relativePath = vscode.workspace.asRelativePath(document.uri, false).replace(/\\/g, "/");
  return !matchesIgnoredPath(relativePath, options.ignoredPaths);
}

export function scanDocument(document: vscode.TextDocument, options: ScannerOptions): SecretFinding[] {
  if (!shouldScanDocument(document, options)) {
    return [];
  }

  const text = document.getText();
  const findingsByRange = new Map<string, SecretFinding>();

  for (const rule of secretRules) {
    rule.regex.lastIndex = 0;

    for (const match of text.matchAll(rule.regex)) {
      if (match.index === undefined) {
        continue;
      }

      const rawValue = getMatchedValue(match, rule);
      const value = rawValue.trim();

      if (!isLikelyRealSecret(value, rule, options.minimumSecretLength)) {
        continue;
      }

      const valueOffset = getValueOffset(match[0], rawValue);
      const startOffset = match.index + valueOffset;
      const endOffset = startOffset + rawValue.length;
      const range = new vscode.Range(document.positionAt(startOffset), document.positionAt(endOffset));
      const lineText = document.lineAt(range.start.line).text;
      const finding: SecretFinding = {
        ruleId: rule.id,
        ruleName: rule.name,
        severity: rule.severity,
        message: rule.message,
        value,
        range,
        lineText
      };

      upsertFinding(findingsByRange, finding);
    }
  }

  return [...findingsByRange.values()].sort((left, right) => {
    return left.range.start.compareTo(right.range.start);
  });
}

function isSupportedFile(fileName: string): boolean {
  const baseName = path.basename(fileName).toLowerCase();
  if (baseName === ".env" || baseName.startsWith(".env.")) {
    return true;
  }

  return supportedExtensions.has(path.extname(fileName).toLowerCase());
}

function matchesIgnoredPath(relativePath: string, patterns: string[]): boolean {
  return patterns.some((pattern) => {
    const normalizedPattern = pattern.replace(/\\/g, "/").replace(/^\/+/, "");
    const candidates = normalizedPattern.startsWith("**/")
      ? [normalizedPattern, normalizedPattern.slice(3)]
      : [normalizedPattern];

    return candidates.some((candidate) => getGlobRegExp(candidate).test(relativePath));
  });
}

function getGlobRegExp(pattern: string): RegExp {
  const cached = globCache.get(pattern);
  if (cached) {
    return cached;
  }

  let source = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];

    if (char === "*") {
      if (pattern[index + 1] === "*") {
        source += ".*";
        index += 1;
      } else {
        source += "[^/]*";
      }
      continue;
    }

    if (char === "?") {
      source += "[^/]";
      continue;
    }

    source += escapeRegExp(char);
  }

  const regex = new RegExp(`${source}$`);
  globCache.set(pattern, regex);
  return regex;
}

function escapeRegExp(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

function getMatchedValue(match: RegExpMatchArray, rule: SecretRule): string {
  if (rule.valueGroup === undefined) {
    return match[0];
  }

  return match[rule.valueGroup] ?? "";
}

function getValueOffset(matchText: string, rawValue: string): number {
  const valueOffset = matchText.indexOf(rawValue);
  return valueOffset >= 0 ? valueOffset : 0;
}

function isLikelyRealSecret(value: string, rule: SecretRule, configuredMinimumLength: number): boolean {
  const minimumLength = rule.minimumLength ?? configuredMinimumLength;

  if (rule.valueGroup !== undefined && value.length < minimumLength) {
    return false;
  }

  if (rule.id === "private-key") {
    return true;
  }

  return !isCommonFakeValue(value);
}

function isCommonFakeValue(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  const compact = normalized.replace(/[\s_-]/g, "");

  if (fakeExactValues.has(normalized) || fakeExactValues.has(compact)) {
    return true;
  }

  if (/^[x*._-]+$/.test(normalized)) {
    return true;
  }

  return fakeValueFragments.some((fragment) => normalized.includes(fragment));
}

function upsertFinding(findingsByRange: Map<string, SecretFinding>, finding: SecretFinding): void {
  const key = `${finding.range.start.line}:${finding.range.start.character}:${finding.range.end.line}:${finding.range.end.character}`;
  const existing = findingsByRange.get(key);

  if (!existing || severityRank(finding.severity) > severityRank(existing.severity)) {
    findingsByRange.set(key, finding);
  }
}

function severityRank(severity: SecretRuleSeverity): number {
  switch (severity) {
    case "high":
      return 3;
    case "medium":
      return 2;
    case "low":
      return 1;
  }
}
