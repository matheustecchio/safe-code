import * as crypto from "crypto";

export type IgnoredWarning = {
  filePath: string;
  lineHash: string;
  ruleId: string;
};

export type ProjectIgnoreConfig = {
  version: 1;
  ignoredWarnings: IgnoredWarning[];
};

export class ProjectIgnoreConfigError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ProjectIgnoreConfigError";
  }
}

export function hashLineText(lineText: string): string {
  return crypto.createHash("sha256").update(lineText.trim()).digest("hex").slice(0, 24);
}

export function createIgnoredWarning(filePath: string, lineText: string, ruleId: string): IgnoredWarning {
  return {
    filePath,
    lineHash: hashLineText(lineText),
    ruleId
  };
}

export function matchesIgnoredWarning(candidate: IgnoredWarning, warning: IgnoredWarning): boolean {
  return (
    candidate.filePath === warning.filePath &&
    candidate.lineHash === warning.lineHash &&
    candidate.ruleId === warning.ruleId
  );
}

export function isIgnoredWarning(value: unknown): value is IgnoredWarning {
  if (!value || typeof value !== "object") {
    return false;
  }

  const warning = value as Record<string, unknown>;
  return (
    typeof warning.filePath === "string" &&
    typeof warning.lineHash === "string" &&
    typeof warning.ruleId === "string"
  );
}

export function normalizeProjectFilePath(filePath: string): string {
  const normalizedSeparators = filePath.replace(/\\/g, "/");
  const segments = normalizedSeparators.split("/");

  if (
    normalizedSeparators.length === 0 ||
    normalizedSeparators.startsWith("/") ||
    /^[A-Za-z]:\//.test(normalizedSeparators) ||
    segments.some((segment) => segment === "..")
  ) {
    throw new ProjectIgnoreConfigError(`Invalid workspace-relative file path: ${filePath}`);
  }

  const normalizedSegments = segments.filter((segment) => segment.length > 0 && segment !== ".");
  if (normalizedSegments.length === 0) {
    throw new ProjectIgnoreConfigError(`Invalid workspace-relative file path: ${filePath}`);
  }

  return normalizedSegments.join("/");
}

export function parseProjectIgnoreConfig(content: string): ProjectIgnoreConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new ProjectIgnoreConfigError(`Invalid JSON: ${String(error)}`);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ProjectIgnoreConfigError("The project ignore configuration must be a JSON object.");
  }

  const config = parsed as Record<string, unknown>;
  assertOnlyKeys(config, ["version", "ignoredWarnings"], "project ignore configuration");
  if (config.version !== 1) {
    throw new ProjectIgnoreConfigError('The project ignore configuration must contain "version": 1.');
  }
  if (!Array.isArray(config.ignoredWarnings)) {
    throw new ProjectIgnoreConfigError('The project ignore configuration must contain an "ignoredWarnings" array.');
  }

  const ignoredWarnings: IgnoredWarning[] = [];
  for (const [index, value] of config.ignoredWarnings.entries()) {
    if (!isIgnoredWarning(value)) {
      throw new ProjectIgnoreConfigError(`Invalid ignored warning at index ${index}.`);
    }
    assertOnlyKeys(
      value as unknown as Record<string, unknown>,
      ["filePath", "lineHash", "ruleId"],
      `ignored warning at index ${index}`
    );
    if (!/^[a-f0-9]{24}$/.test(value.lineHash)) {
      throw new ProjectIgnoreConfigError(`Invalid line hash at ignored warning index ${index}.`);
    }
    if (value.ruleId.trim().length === 0) {
      throw new ProjectIgnoreConfigError(`Invalid rule ID at ignored warning index ${index}.`);
    }

    const warning = {
      filePath: normalizeProjectFilePath(value.filePath),
      lineHash: value.lineHash,
      ruleId: value.ruleId
    };
    if (!ignoredWarnings.some((candidate) => matchesIgnoredWarning(candidate, warning))) {
      ignoredWarnings.push(warning);
    }
  }

  return { version: 1, ignoredWarnings };
}

export function serializeProjectIgnoreConfig(config: ProjectIgnoreConfig): string {
  return `${JSON.stringify(config, null, 2)}\n`;
}

function assertOnlyKeys(value: Record<string, unknown>, allowedKeys: string[], context: string): void {
  const unexpectedKey = Object.keys(value).find((key) => !allowedKeys.includes(key));
  if (unexpectedKey) {
    throw new ProjectIgnoreConfigError(`Unexpected property "${unexpectedKey}" in ${context}.`);
  }
}
