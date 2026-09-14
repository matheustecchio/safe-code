import { randomBytes } from "crypto";
import { BigIntStats, constants } from "fs";
import { FileHandle, lstat, open, rename, unlink } from "fs/promises";
import * as path from "path";
import {
  IgnoredWarning,
  matchesIgnoredWarning,
  parseProjectIgnoreConfig,
  ProjectIgnoreConfig,
  serializeProjectIgnoreConfig
} from "./ignoreCore";

export const projectIgnoreConfigFileName = ".safe-code.json";

export type ProjectIgnoreFileErrorCode =
  | "concurrent-modification"
  | "invalid-configuration"
  | "read-failed"
  | "unsafe-target"
  | "write-failed";

export class ProjectIgnoreFileError extends Error {
  public constructor(
    public readonly code: ProjectIgnoreFileErrorCode,
    message: string
  ) {
    super(message);
    this.name = "ProjectIgnoreFileError";
  }
}

const projectIgnoreFileErrorMessages: Record<ProjectIgnoreFileErrorCode, string> = {
  "concurrent-modification": `${projectIgnoreConfigFileName} changed while Safe Code was updating it. No project ignore was written.`,
  "invalid-configuration": `${projectIgnoreConfigFileName} is invalid and was not changed.`,
  "read-failed": `Safe Code could not safely read ${projectIgnoreConfigFileName}.`,
  "unsafe-target": `${projectIgnoreConfigFileName} must be a regular file. Symbolic links and other file types are not allowed.`,
  "write-failed": `Safe Code could not safely write ${projectIgnoreConfigFileName}.`
};

type FileIdentity = Readonly<{
  ctimeNs: bigint;
  dev: bigint;
  gid: bigint;
  ino: bigint;
  mode: bigint;
  mtimeNs: bigint;
  nlink: bigint;
  size: bigint;
  uid: bigint;
}>;

export type ProjectIgnoreFileSnapshot =
  | Readonly<{ kind: "missing" }>
  | Readonly<{
      bytes: Buffer;
      identity: FileIdentity;
      kind: "regular";
    }>;

export type ProjectIgnoreFileUpdate = Readonly<{
  changed: boolean;
  config: ProjectIgnoreConfig;
}>;

const missingSnapshot: ProjectIgnoreFileSnapshot = { kind: "missing" };
const noFollowFlag = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
const nonBlockingFlag = typeof constants.O_NONBLOCK === "number" ? constants.O_NONBLOCK : 0;

export async function readProjectIgnoreConfigFile(configPath: string): Promise<ProjectIgnoreConfig> {
  return parseSnapshot(await readProjectIgnoreFileSnapshot(configPath));
}

export function getProjectIgnoreFileErrorMessage(
  error: unknown,
  fallbackCode: ProjectIgnoreFileErrorCode
): string {
  const code = error instanceof ProjectIgnoreFileError ? error.code : fallbackCode;
  return projectIgnoreFileErrorMessages[code];
}

export function normalizeProjectIgnoreFileError(
  error: unknown,
  fallbackCode: ProjectIgnoreFileErrorCode
): ProjectIgnoreFileError {
  const code = error instanceof ProjectIgnoreFileError ? error.code : fallbackCode;
  return createFileError(code);
}

export async function addProjectIgnoredWarning(
  configPath: string,
  warning: IgnoredWarning
): Promise<ProjectIgnoreFileUpdate> {
  const snapshot = await readProjectIgnoreFileSnapshot(configPath);
  const config = parseSnapshot(snapshot);
  if (config.ignoredWarnings.some((candidate) => matchesIgnoredWarning(candidate, warning))) {
    return { changed: false, config };
  }

  const updatedConfig: ProjectIgnoreConfig = {
    version: 1,
    ignoredWarnings: [...config.ignoredWarnings, warning].sort(compareWarnings)
  };
  const nextBytes = Buffer.from(serializeProjectIgnoreConfig(updatedConfig), "utf8");
  await writeProjectIgnoreFile(configPath, snapshot, nextBytes);
  return { changed: true, config: updatedConfig };
}

export async function readProjectIgnoreFileSnapshot(configPath: string): Promise<ProjectIgnoreFileSnapshot> {
  const pathStat = await inspectConfigPath(configPath, "read");
  if (!pathStat) {
    return missingSnapshot;
  }

  let handle: FileHandle;
  try {
    handle = await open(configPath, constants.O_RDONLY | noFollowFlag | nonBlockingFlag);
  } catch (error) {
    if (isErrno(error, "ELOOP")) {
      throw createFileError("unsafe-target");
    }
    if (isErrno(error, "ENOENT")) {
      throw createFileError("concurrent-modification");
    }
    throw createFileError("read-failed");
  }

  let snapshot: ProjectIgnoreFileSnapshot;
  try {
    const beforeRead = await safeHandleStat(handle, "read");
    assertRegularFile(beforeRead);
    if (!sameIdentity(toIdentity(pathStat), toIdentity(beforeRead))) {
      throw createFileError("concurrent-modification");
    }

    let bytes: Buffer;
    try {
      bytes = await handle.readFile();
    } catch {
      throw createFileError("read-failed");
    }

    const afterRead = await safeHandleStat(handle, "read");
    const finalPathStat = await inspectConfigPath(configPath, "revalidate");
    if (
      !finalPathStat ||
      !sameStableFile(toIdentity(beforeRead), toIdentity(afterRead)) ||
      !sameStableFile(toIdentity(afterRead), toIdentity(finalPathStat)) ||
      BigInt(bytes.byteLength) !== afterRead.size
    ) {
      throw createFileError("concurrent-modification");
    }

    snapshot = {
      bytes,
      identity: toIdentity(afterRead),
      kind: "regular"
    };
  } catch (error) {
    await closeHandleQuietly(handle);
    throw asFileError(error, "read-failed");
  }

  await closeHandle(handle, "read");
  return snapshot;
}

export async function writeProjectIgnoreFile(
  configPath: string,
  expected: ProjectIgnoreFileSnapshot,
  nextBytes: Buffer
): Promise<void> {
  if (expected.kind === "missing") {
    await createProjectIgnoreFile(configPath, nextBytes);
    return;
  }

  await replaceProjectIgnoreFile(configPath, expected, nextBytes);
}

async function createProjectIgnoreFile(configPath: string, nextBytes: Buffer): Promise<void> {
  let handle: FileHandle;
  try {
    handle = await open(
      configPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollowFlag,
      0o600
    );
  } catch (error) {
    if (isErrno(error, "EEXIST") || isErrno(error, "ELOOP")) {
      throw createFileError("concurrent-modification");
    }
    throw createFileError("write-failed");
  }

  let writtenIdentity: FileIdentity | undefined;
  try {
    const openedStat = await safeHandleStat(handle, "write");
    assertRegularFile(openedStat);
    writtenIdentity = toIdentity(openedStat);
    await safeWriteAndSync(handle, nextBytes);
    writtenIdentity = toIdentity(await safeHandleStat(handle, "write"));
  } catch (error) {
    await closeHandleQuietly(handle);
    if (writtenIdentity) {
      await removeOwnedFile(configPath, writtenIdentity);
    }
    throw asFileError(error, "write-failed");
  }

  try {
    await closeHandle(handle, "write");
    await verifyWrittenFile(configPath, writtenIdentity, nextBytes);
  } catch (error) {
    await removeOwnedFile(configPath, writtenIdentity);
    throw asFileError(error, "write-failed");
  }
}

async function replaceProjectIgnoreFile(
  configPath: string,
  expected: Extract<ProjectIgnoreFileSnapshot, { kind: "regular" }>,
  nextBytes: Buffer
): Promise<void> {
  const temporaryPath = await createTemporarySibling(configPath, expected.identity.mode, nextBytes);
  let replaced = false;
  try {
    const current = await readProjectIgnoreFileSnapshot(configPath);
    if (
      current.kind !== "regular" ||
      !sameStableFile(expected.identity, current.identity) ||
      !current.bytes.equals(expected.bytes)
    ) {
      throw createFileError("concurrent-modification");
    }

    try {
      await rename(temporaryPath.path, configPath);
      replaced = true;
    } catch {
      throw createFileError("write-failed");
    }

    await verifyWrittenFile(configPath, temporaryPath.identity, nextBytes);
  } finally {
    if (!replaced) {
      await removeOwnedFile(temporaryPath.path, temporaryPath.identity);
    }
  }
}

async function createTemporarySibling(
  configPath: string,
  existingMode: bigint,
  nextBytes: Buffer
): Promise<Readonly<{ identity: FileIdentity; path: string }>> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const temporaryPath = path.join(
      path.dirname(configPath),
      `${path.basename(configPath)}.tmp-${process.pid}-${randomBytes(12).toString("hex")}`
    );

    let handle: FileHandle;
    try {
      handle = await open(
        temporaryPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollowFlag,
        0o600
      );
    } catch (error) {
      if (isErrno(error, "EEXIST")) {
        continue;
      }
      throw createFileError("write-failed");
    }

    let temporaryIdentity: FileIdentity | undefined;
    try {
      const openedStat = await safeHandleStat(handle, "write");
      assertRegularFile(openedStat);
      temporaryIdentity = toIdentity(openedStat);
      await safeWriteAndSync(handle, nextBytes);
      try {
        await handle.chmod(Number(existingMode & 0o777n));
        await handle.sync();
      } catch {
        throw createFileError("write-failed");
      }
      temporaryIdentity = toIdentity(await safeHandleStat(handle, "write"));
    } catch (error) {
      await closeHandleQuietly(handle);
      if (temporaryIdentity) {
        await removeOwnedFile(temporaryPath, temporaryIdentity);
      }
      throw asFileError(error, "write-failed");
    }

    try {
      await closeHandle(handle, "write");
    } catch (error) {
      await removeOwnedFile(temporaryPath, temporaryIdentity);
      throw error;
    }

    return {
      identity: temporaryIdentity,
      path: temporaryPath
    };
  }

  throw createFileError("write-failed");
}

async function verifyWrittenFile(configPath: string, expectedIdentity: FileIdentity, expectedBytes: Buffer): Promise<void> {
  const written = await readProjectIgnoreFileSnapshot(configPath);
  if (
    written.kind !== "regular" ||
    !sameIdentity(expectedIdentity, written.identity) ||
    !written.bytes.equals(expectedBytes)
  ) {
    throw createFileError("concurrent-modification");
  }
}

async function inspectConfigPath(configPath: string, operation: "read" | "revalidate"): Promise<BigIntStats | undefined> {
  let stat: BigIntStats;
  try {
    stat = await lstat(configPath, { bigint: true });
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      return undefined;
    }
    throw createFileError(operation === "read" ? "read-failed" : "concurrent-modification");
  }

  assertRegularFile(stat);
  return stat;
}

async function safeHandleStat(handle: FileHandle, operation: "read" | "write"): Promise<BigIntStats> {
  try {
    return await handle.stat({ bigint: true });
  } catch {
    throw createFileError(operation === "read" ? "read-failed" : "write-failed");
  }
}

function assertRegularFile(stat: BigIntStats): void {
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw createFileError("unsafe-target");
  }
}

async function safeWriteAndSync(handle: FileHandle, bytes: Buffer): Promise<void> {
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } catch {
    throw createFileError("write-failed");
  }
}

async function removeOwnedFile(filePath: string, expectedIdentity: FileIdentity): Promise<void> {
  try {
    const stat = await lstat(filePath, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink()) {
      return;
    }
    if (!sameIdentity(expectedIdentity, toIdentity(stat))) {
      return;
    }
    await unlink(filePath);
  } catch (error) {
    if (!isErrno(error, "ENOENT")) {
      // Cleanup is best effort and must not replace the primary redacted error.
    }
  }
}

async function closeHandle(handle: FileHandle, operation: "read" | "write"): Promise<void> {
  try {
    await handle.close();
  } catch {
    throw createFileError(operation === "read" ? "read-failed" : "write-failed");
  }
}

async function closeHandleQuietly(handle: FileHandle): Promise<void> {
  try {
    await handle.close();
  } catch {
    // The primary typed operation error remains more useful than a close failure.
  }
}

function parseSnapshot(snapshot: ProjectIgnoreFileSnapshot): ProjectIgnoreConfig {
  if (snapshot.kind === "missing") {
    return { version: 1, ignoredWarnings: [] };
  }

  try {
    return parseProjectIgnoreConfig(snapshot.bytes.toString("utf8"));
  } catch {
    throw createFileError("invalid-configuration");
  }
}

function toIdentity(stat: BigIntStats): FileIdentity {
  return {
    ctimeNs: stat.ctimeNs,
    dev: stat.dev,
    gid: stat.gid,
    ino: stat.ino,
    mode: stat.mode,
    mtimeNs: stat.mtimeNs,
    nlink: stat.nlink,
    size: stat.size,
    uid: stat.uid
  };
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameStableFile(left: FileIdentity, right: FileIdentity): boolean {
  return (
    sameIdentity(left, right) &&
    left.ctimeNs === right.ctimeNs &&
    left.gid === right.gid &&
    left.mode === right.mode &&
    left.mtimeNs === right.mtimeNs &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.uid === right.uid
  );
}

function compareWarnings(left: IgnoredWarning, right: IgnoredWarning): number {
  return (
    left.filePath.localeCompare(right.filePath) ||
    left.ruleId.localeCompare(right.ruleId) ||
    left.lineHash.localeCompare(right.lineHash)
  );
}

function createFileError(code: ProjectIgnoreFileErrorCode): ProjectIgnoreFileError {
  return new ProjectIgnoreFileError(code, projectIgnoreFileErrorMessages[code]);
}

function asFileError(error: unknown, fallbackCode: ProjectIgnoreFileErrorCode): ProjectIgnoreFileError {
  return normalizeProjectIgnoreFileError(error, fallbackCode);
}

function isErrno(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === code);
}
