import * as path from "path";
import { secretRules, SecretRule, SecretRuleSeverity } from "./rules";

export type CoreScannerOptions = {
  minimumSecretLength: number;
};

export type OffsetSecretFinding = {
  ruleId: string;
  ruleName: string;
  severity: SecretRuleSeverity;
  message: string;
  value: string;
  startOffset: number;
  endOffset: number;
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

export function shouldScanFile(fileName: string, relativePath: string, ignoredPaths: string[]): boolean {
  if (!isSupportedFile(fileName)) {
    return false;
  }

  const normalizedRelativePath = relativePath.replace(/\\/g, "/");
  return !matchesIgnoredPath(normalizedRelativePath, ignoredPaths);
}

export function scanText(text: string, options: CoreScannerOptions): OffsetSecretFinding[] {
  const findingsByRange = new Map<string, OffsetSecretFinding>();

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
      const finding: OffsetSecretFinding = {
        ruleId: rule.id,
        ruleName: rule.name,
        severity: rule.severity,
        message: rule.message,
        value,
        startOffset,
        endOffset,
        lineText: getLineText(text, startOffset)
      };

      upsertFinding(findingsByRange, finding);
    }
  }

  return [...findingsByRange.values()].sort((left, right) => left.startOffset - right.startOffset);
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

function getLineText(text: string, offset: number): string {
  const lineStart = text.lastIndexOf("\n", Math.max(0, offset - 1)) + 1;
  const nextLineBreak = text.indexOf("\n", offset);
  const lineEnd = nextLineBreak >= 0 ? nextLineBreak : text.length;
  const lineText = text.slice(lineStart, lineEnd);
  return lineText.endsWith("\r") ? lineText.slice(0, -1) : lineText;
}

function upsertFinding(findingsByRange: Map<string, OffsetSecretFinding>, finding: OffsetSecretFinding): void {
  const key = `${finding.startOffset}:${finding.endOffset}`;
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
