export type EnvironmentAssignment = {
  environmentVariableName: string;
  replacementEndCharacter: number;
  replacementStartCharacter: number;
  replacement: string;
  secretValue: string;
  variableName: string;
};

export class EnvironmentVariableConflictError extends Error {
  public constructor(environmentVariableName: string) {
    super(`Environment variable ${environmentVariableName} already has a different value.`);
    this.name = "EnvironmentVariableConflictError";
  }
}

const supportedExtensions = new Set([".js", ".jsx", ".ts", ".tsx"]);
const assignmentPattern = /^(\s*)(?:(?:export\s+)?(?:const|let|var)\s+)?([A-Za-z_$][A-Za-z0-9_$]*)(?:\s*:\s*[^=;]+)?\s*=\s*(["'])([^"'`\\\r\n]+)\3\s*;?\s*$/;

export function isSupportedEnvironmentFixFile(fileName: string): boolean {
  const dotIndex = fileName.lastIndexOf(".");
  return dotIndex >= 0 && supportedExtensions.has(fileName.slice(dotIndex).toLowerCase());
}

export function analyzeEnvironmentAssignment(
  lineText: string,
  diagnosticStartCharacter: number,
  diagnosticEndCharacter: number
): EnvironmentAssignment | undefined {
  const match = assignmentPattern.exec(lineText);
  if (!match) {
    return undefined;
  }

  const variableName = match[2];
  const quote = match[3];
  const secretValue = match[4];
  const quotedValue = `${quote}${secretValue}${quote}`;
  const quotedValueStart = lineText.indexOf(quotedValue);
  if (quotedValueStart < 0) {
    return undefined;
  }

  const valueStartCharacter = quotedValueStart + 1;
  const valueEndCharacter = valueStartCharacter + secretValue.length;
  if (
    diagnosticStartCharacter !== valueStartCharacter ||
    diagnosticEndCharacter !== valueEndCharacter
  ) {
    return undefined;
  }

  const environmentVariableName = inferEnvironmentVariableName(variableName);
  if (!environmentVariableName) {
    return undefined;
  }

  return {
    environmentVariableName,
    replacementEndCharacter: quotedValueStart + quotedValue.length,
    replacementStartCharacter: quotedValueStart,
    replacement: `process.env.${environmentVariableName}`,
    secretValue,
    variableName
  };
}

export function inferEnvironmentVariableName(variableName: string): string | undefined {
  const normalized = variableName
    .replace(/^\$+/, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_")
    .toUpperCase();

  return /^[A-Z][A-Z0-9_]*$/.test(normalized) ? normalized : undefined;
}

export function upsertEnvironmentValue(
  content: string,
  environmentVariableName: string,
  secretValue: string
): string {
  const line = `${environmentVariableName}=${JSON.stringify(secretValue)}`;
  const existingLines = findEnvironmentVariableLines(content, environmentVariableName);

  if (existingLines.length > 0) {
    if (existingLines.length === 1 && existingLines[0].trim() === line) {
      return content;
    }
    throw new EnvironmentVariableConflictError(environmentVariableName);
  }

  return appendLine(content, line);
}

export function upsertEnvironmentExample(content: string, environmentVariableName: string): string {
  const existingLines = findEnvironmentVariableLines(content, environmentVariableName);
  if (existingLines.length > 1) {
    throw new EnvironmentVariableConflictError(environmentVariableName);
  }
  if (existingLines.length === 1) {
    return content;
  }

  return appendLine(content, `${environmentVariableName}=`);
}

export function ensureEnvironmentFileIgnored(content: string): string {
  const effectiveRules = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
  const finalRules = effectiveRules.slice(-2);

  if (finalRules[0] === "/.safe-code-tmp-*" && finalRules[1] === "/.env") {
    return content;
  }

  return appendLine(appendLine(content, "/.safe-code-tmp-*"), "/.env");
}

function findEnvironmentVariableLines(content: string, environmentVariableName: string): string[] {
  const escapedName = escapeRegExp(environmentVariableName);
  const pattern = new RegExp(`^\\s*(?:export\\s+)?${escapedName}\\s*=`);
  return content.split(/\r?\n/).filter((line) => pattern.test(line));
}

function appendLine(content: string, line: string): string {
  if (content.length === 0) {
    return `${line}\n`;
  }

  const separator = content.includes("\r\n") ? "\r\n" : "\n";
  return `${content}${content.endsWith("\n") ? "" : separator}${line}${separator}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[|\\{}()[\]^$+*?.-]/g, "\\$&");
}
