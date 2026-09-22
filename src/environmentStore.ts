import { execFile } from "child_process";
import { randomBytes } from "crypto";
import { constants } from "fs";
import { link, lstat, open, realpath, rename, unlink } from "fs/promises";
import * as path from "path";
import {
  ensureEnvironmentFileIgnored,
  EnvironmentVariableConflictError,
  upsertEnvironmentExample,
  upsertEnvironmentValue
} from "./environmentFixCore";
import {
  AppliedEnvironmentMigrationError,
  EnvironmentMigrationError,
  EnvironmentMigrationMutation,
  EnvironmentMigrationStep
} from "./environmentMigrationCore";

const maximumTargetBytes = 1_048_576;
const noFollowFlag = constants.O_NOFOLLOW ?? 0;
const supportsPosixPermissions = process.platform !== "win32";

type EnvironmentFileStep = Exclude<EnvironmentMigrationStep, "source">;

type MissingFileSnapshot = {
  bytes: Buffer;
  content: string;
  exists: false;
  filePath: string;
};

type ExistingFileSnapshot = {
  bytes: Buffer;
  content: string;
  exists: true;
  filePath: string;
  identity: string;
  inode: string;
  mode: number;
};

export type EnvironmentFileSnapshot = MissingFileSnapshot | ExistingFileSnapshot;

type PreparedFile = {
  before: EnvironmentFileSnapshot;
  expected: EnvironmentFileSnapshot;
  nextBytes: Buffer;
  step: EnvironmentFileStep;
};

export type EnvironmentStoreHooks = {
  afterWrite?(step: EnvironmentFileStep): Promise<void> | void;
  afterTemporaryWrite?(
    step: EnvironmentFileStep,
    purpose: "backup" | "replacement",
    temporaryPath: string
  ): Promise<void> | void;
  beforeBackupRemoval?(step: EnvironmentFileStep, backupPath: string): Promise<void> | void;
  beforeRecoveryRestore?(step: EnvironmentFileStep, targetPath: string): Promise<void> | void;
  beforeWrite?(step: EnvironmentFileStep): Promise<void> | void;
};

export type EnvironmentWorkspaceIdentity = {
  identity: string;
  key: string;
};

type GitResult = {
  code: number | string;
  stderr: string;
  stdout: string;
};

class UnrecoverableFileMutationError extends Error {
  public constructor() {
    super("A file mutation could not be safely recovered.");
    this.name = "UnrecoverableFileMutationError";
  }
}

function createUnrecoverableMutation(step: EnvironmentFileStep): EnvironmentMigrationMutation {
  return {
    step,
    rollback: async () => {
      throw new EnvironmentMigrationError("rollback-failed");
    },
    verify: async () => {
      throw new EnvironmentMigrationError("rollback-failed");
    }
  };
}

export class EnvironmentStore {
  private gitRepository: boolean | undefined;
  private preparedFiles: Record<EnvironmentFileStep, PreparedFile> | undefined;
  private workspaceRootIdentity: string | undefined;

  public constructor(
    private readonly workspaceRoot: string,
    private readonly hooks: EnvironmentStoreHooks = {},
    private readonly expectedWorkspaceIdentity?: string
  ) {}

  public async prepare(environmentVariableName: string, secretValue: string): Promise<void> {
    this.workspaceRootIdentity = await readSafeWorkspaceRootIdentity(this.workspaceRoot);
    if (
      this.expectedWorkspaceIdentity &&
      this.workspaceRootIdentity !== this.expectedWorkspaceIdentity
    ) {
      throw new EnvironmentMigrationError("concurrent-change");
    }
    this.gitRepository = await inspectGitRepository(this.workspaceRoot);

    const gitignore = await readExactTextFile(path.join(this.workspaceRoot, ".gitignore"));
    const example = await readExactTextFile(path.join(this.workspaceRoot, ".env.example"));
    const environment = await readExactTextFile(path.join(this.workspaceRoot, ".env"));

    if (this.gitRepository) {
      await assertEnvironmentUntracked(this.workspaceRoot);
    }

    let nextEnvironment: string;
    let nextExample: string;
    try {
      nextEnvironment = upsertEnvironmentValue(
        environment.content,
        environmentVariableName,
        secretValue
      );
      nextExample = upsertEnvironmentExample(example.content, environmentVariableName);
    } catch (error) {
      if (error instanceof EnvironmentVariableConflictError) {
        throw new EnvironmentMigrationError("conflict", { cause: error });
      }
      throw new EnvironmentMigrationError("unsafe-target", { cause: error });
    }

    const nextGitignore = ensureEnvironmentFileIgnored(gitignore.content);

    this.preparedFiles = {
      gitignore: prepareFile("gitignore", gitignore, nextGitignore),
      example: prepareFile("example", example, nextExample),
      environment: prepareFile("environment", environment, nextEnvironment)
    };

    await this.validateAll();
  }

  public async beforeStep(step: EnvironmentMigrationStep): Promise<void> {
    await this.validateAll();

    if ((step === "environment" || step === "source") && this.gitRepository === true) {
      await assertEnvironmentUntracked(this.workspaceRoot);
      await assertEnvironmentIgnored(this.workspaceRoot);
    }
  }

  public async apply(step: EnvironmentFileStep): Promise<EnvironmentMigrationMutation | undefined> {
    const prepared = this.getPreparedFile(step);
    if (prepared.expected.bytes.equals(prepared.nextBytes)) {
      return undefined;
    }

    try {
      await this.hooks.beforeWrite?.(step);
      await this.validateAll();
      if (step === "environment" && this.gitRepository === true) {
        await assertEnvironmentUntracked(this.workspaceRoot);
        await assertEnvironmentIgnored(this.workspaceRoot);
        await assertTemporaryFilesIgnored(this.workspaceRoot);
      }
      const mode = step === "environment"
        ? 0o600
        : prepared.expected.exists
          ? prepared.expected.mode
          : 0o644;
      const temporaryDirectory = path.dirname(prepared.expected.filePath);
      const after = await replaceExactFile(
        prepared.expected,
        prepared.nextBytes,
        mode,
        temporaryDirectory,
        async (backupPath) => this.hooks.beforeBackupRemoval?.(step, backupPath),
        async (targetPath) => this.hooks.beforeRecoveryRestore?.(step, targetPath),
        async (purpose, temporaryPath) => {
          await this.hooks.afterTemporaryWrite?.(step, purpose, temporaryPath);
        }
      );
      prepared.expected = after;
      const rollbackProtection = step === "environment"
        ? async () => {
            await this.assertGitRepositoryUnchanged();
            if (this.gitRepository !== true) {
              return;
            }
            await assertEnvironmentUntracked(this.workspaceRoot);
            await assertEnvironmentIgnored(this.workspaceRoot);
            await assertTemporaryFilesIgnored(this.workspaceRoot);
          }
        : undefined;
      const mutation = new EnvironmentFileMutation(
        step,
        prepared.before,
        after,
        temporaryDirectory,
        rollbackProtection
      );

      try {
        await this.hooks.afterWrite?.(step);
      } catch (error) {
        throw new AppliedEnvironmentMigrationError(
          mutation,
          new EnvironmentMigrationError("write-failed", { cause: error })
        );
      }

      return mutation;
    } catch (error) {
      if (error instanceof UnrecoverableFileMutationError) {
        throw new AppliedEnvironmentMigrationError(
          createUnrecoverableMutation(step),
          new EnvironmentMigrationError("rollback-failed", { cause: error })
        );
      }
      if (error instanceof AppliedEnvironmentMigrationError || error instanceof EnvironmentMigrationError) {
        throw error;
      }
      throw new EnvironmentMigrationError("write-failed", { cause: error });
    }
  }

  public async verify(): Promise<void> {
    await this.validateAll();
    if (this.gitRepository === true) {
      await assertEnvironmentUntracked(this.workspaceRoot);
      await assertEnvironmentIgnored(this.workspaceRoot);
      await assertTemporaryFilesIgnored(this.workspaceRoot);
    }
  }

  private async validateAll(): Promise<void> {
    if (
      !this.preparedFiles ||
      !this.workspaceRootIdentity ||
      this.gitRepository === undefined
    ) {
      throw new EnvironmentMigrationError("unsafe-target");
    }

    await assertSafeWorkspaceRootIdentity(this.workspaceRoot, this.workspaceRootIdentity);
    await this.assertGitRepositoryUnchanged();

    for (const prepared of Object.values(this.preparedFiles)) {
      await assertExactSnapshot(prepared.expected);
    }
  }

  private async assertGitRepositoryUnchanged(): Promise<void> {
    if (this.gitRepository === undefined) {
      throw new EnvironmentMigrationError("unsafe-target");
    }
    if (await inspectGitRepository(this.workspaceRoot) !== this.gitRepository) {
      throw new EnvironmentMigrationError("concurrent-change");
    }
  }

  private getPreparedFile(step: EnvironmentFileStep): PreparedFile {
    const prepared = this.preparedFiles?.[step];
    if (!prepared) {
      throw new EnvironmentMigrationError("unsafe-target");
    }
    return prepared;
  }
}

class EnvironmentFileMutation implements EnvironmentMigrationMutation {
  public constructor(
    public readonly step: EnvironmentFileStep,
    private readonly before: EnvironmentFileSnapshot,
    private readonly after: EnvironmentFileSnapshot,
    private readonly temporaryDirectory: string,
    private readonly rollbackProtection?: () => Promise<void>
  ) {}

  public async rollback(): Promise<void> {
    await assertExactSnapshot(this.after);

    if (this.step === "environment") {
      await this.rollbackProtection?.();
    }

    if (!this.before.exists) {
      if (!this.after.exists) {
        throw new EnvironmentMigrationError("rollback-failed");
      }
      await removeOwnedTarget(this.after);
      return;
    }

    const restored = await replaceExactFile(
      this.after,
      this.before.bytes,
      this.before.mode,
      this.temporaryDirectory
    );
    if (
      !restored.exists ||
      !restored.bytes.equals(this.before.bytes) ||
      (supportsPosixPermissions && restored.mode !== this.before.mode)
    ) {
      throw new EnvironmentMigrationError("rollback-failed");
    }
  }

  public async verify(): Promise<void> {
    await assertExactSnapshot(this.after);
  }
}

function prepareFile(
  step: EnvironmentFileStep,
  snapshot: EnvironmentFileSnapshot,
  nextContent: string
): PreparedFile {
  const nextBytes = Buffer.from(nextContent, "utf8");
  if (nextBytes.length > maximumTargetBytes) {
    throw new EnvironmentMigrationError("unsafe-target");
  }
  return {
    before: snapshot,
    expected: snapshot,
    nextBytes,
    step
  };
}

async function readSafeWorkspaceRootIdentity(workspaceRoot: string): Promise<string> {
  try {
    const stat = await lstat(workspaceRoot, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new EnvironmentMigrationError("unsafe-target");
    }
    return workspaceIdentityOf(stat);
  } catch (error) {
    if (error instanceof EnvironmentMigrationError) {
      throw error;
    }
    throw new EnvironmentMigrationError("unsafe-target", { cause: error });
  }
}

async function assertSafeWorkspaceRootIdentity(workspaceRoot: string, expectedIdentity: string): Promise<void> {
  const currentIdentity = await readSafeWorkspaceRootIdentity(workspaceRoot);
  if (currentIdentity !== expectedIdentity) {
    throw new EnvironmentMigrationError("concurrent-change");
  }
}

export async function assertSafeMigrationSource(workspaceRoot: string, sourcePath: string): Promise<void> {
  try {
    const rootIdentity = await readSafeWorkspaceRootIdentity(workspaceRoot);
    const sourceStat = await lstat(sourcePath, { bigint: true });
    if (!sourceStat.isFile() || sourceStat.isSymbolicLink() || sourceStat.nlink !== 1n) {
      throw new EnvironmentMigrationError("invalid-source");
    }

    const [canonicalRoot, canonicalSource] = await Promise.all([
      realpath(workspaceRoot),
      realpath(sourcePath)
    ]);
    const relativeSource = path.relative(canonicalRoot, canonicalSource);
    if (
      relativeSource.length === 0 ||
      relativeSource === ".." ||
      relativeSource.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relativeSource)
    ) {
      throw new EnvironmentMigrationError("invalid-source");
    }

    await assertSafeWorkspaceRootIdentity(workspaceRoot, rootIdentity);
    const finalSourceStat = await lstat(sourcePath, { bigint: true });
    if (identityOf(finalSourceStat) !== identityOf(sourceStat)) {
      throw new EnvironmentMigrationError("concurrent-change");
    }
  } catch (error) {
    if (error instanceof EnvironmentMigrationError) {
      throw error;
    }
    throw new EnvironmentMigrationError("invalid-source", { cause: error });
  }
}

export async function getEnvironmentWorkspaceIdentity(
  workspaceRoot: string
): Promise<EnvironmentWorkspaceIdentity> {
  try {
    const before = await readSafeWorkspaceRootIdentity(workspaceRoot);
    const canonicalPath = await realpath(workspaceRoot);
    const after = await readSafeWorkspaceRootIdentity(workspaceRoot);
    if (before !== after) {
      throw new EnvironmentMigrationError("concurrent-change");
    }
    return { identity: after, key: `${canonicalPath}:${after}` };
  } catch (error) {
    if (error instanceof EnvironmentMigrationError) {
      throw error;
    }
    throw new EnvironmentMigrationError("unsafe-target", { cause: error });
  }
}

async function readExactTextFile(filePath: string): Promise<EnvironmentFileSnapshot> {
  let pathStat;
  try {
    pathStat = await lstat(filePath, { bigint: true });
  } catch (error) {
    if (isFileSystemError(error, "ENOENT")) {
      return { bytes: Buffer.alloc(0), content: "", exists: false, filePath };
    }
    throw new EnvironmentMigrationError("unsafe-target", { cause: error });
  }

  if (!pathStat.isFile() || pathStat.isSymbolicLink()) {
    throw new EnvironmentMigrationError("unsafe-target");
  }
  if (pathStat.size > BigInt(maximumTargetBytes)) {
    throw new EnvironmentMigrationError("unsafe-target");
  }

  let handle;
  try {
    handle = await open(filePath, constants.O_RDONLY | noFollowFlag);
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || identityOf(before) !== identityOf(pathStat)) {
      throw new EnvironmentMigrationError("concurrent-change");
    }
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (identityOf(before) !== identityOf(after) || BigInt(bytes.length) !== after.size) {
      throw new EnvironmentMigrationError("concurrent-change");
    }

    const finalPathStat = await lstat(filePath, { bigint: true });
    if (identityOf(after) !== identityOf(finalPathStat)) {
      throw new EnvironmentMigrationError("concurrent-change");
    }

    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch (error) {
      throw new EnvironmentMigrationError("unsafe-target", { cause: error });
    }
    if (content.includes("\0")) {
      throw new EnvironmentMigrationError("unsafe-target");
    }

    return {
      bytes,
      content,
      exists: true,
      filePath,
      identity: identityOf(after),
      inode: inodeOf(after),
      mode: Number(after.mode & 0o777n)
    };
  } catch (error) {
    if (error instanceof EnvironmentMigrationError) {
      throw error;
    }
    throw new EnvironmentMigrationError("unsafe-target", { cause: error });
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function assertExactSnapshot(expected: EnvironmentFileSnapshot): Promise<void> {
  let current: EnvironmentFileSnapshot;
  try {
    current = await readExactTextFile(expected.filePath);
  } catch (error) {
    throw new EnvironmentMigrationError("concurrent-change", { cause: error });
  }

  if (
    current.exists !== expected.exists ||
    !current.bytes.equals(expected.bytes) ||
    (current.exists && expected.exists &&
      (current.identity !== expected.identity || current.mode !== expected.mode))
  ) {
    throw new EnvironmentMigrationError("concurrent-change");
  }
}

async function assertMissing(filePath: string): Promise<void> {
  try {
    await lstat(filePath);
  } catch (error) {
    if (isFileSystemError(error, "ENOENT")) {
      return;
    }
    throw new EnvironmentMigrationError("rollback-failed", { cause: error });
  }
  throw new EnvironmentMigrationError("rollback-failed");
}

async function replaceExactFile(
  expected: EnvironmentFileSnapshot,
  bytes: Buffer,
  mode: number,
  temporaryDirectory: string,
  beforeBackupRemoval?: (backupPath: string) => Promise<void>,
  beforeRecoveryRestore?: (targetPath: string) => Promise<void>,
  afterTemporaryWrite?: (
    purpose: "backup" | "replacement",
    temporaryPath: string
  ) => Promise<void>
): Promise<EnvironmentFileSnapshot> {
  const temporary = await createTemporaryFile(
    temporaryDirectory,
    bytes,
    mode,
    async (temporaryPath) => afterTemporaryWrite?.("replacement", temporaryPath)
  );
  let backup: ExistingFileSnapshot | undefined;
  let committed = false;
  try {
    await assertExactSnapshot(expected);
    await assertExactSnapshot(temporary);

    if (expected.exists) {
      backup = await createTemporaryFile(
        temporaryDirectory,
        expected.bytes,
        0o600,
        async (temporaryPath) => afterTemporaryWrite?.("backup", temporaryPath)
      );
      await assertExactSnapshot(expected);

      await rename(temporary.filePath, expected.filePath);
      committed = true;
    } else {
      try {
        await link(temporary.filePath, expected.filePath);
        committed = true;
      } catch (error) {
        if (isFileSystemError(error, "EEXIST")) {
          throw new EnvironmentMigrationError("concurrent-change", { cause: error });
        }
        throw error;
      }
    }

    const linked = await readAndVerifyWrittenFile(expected.filePath, bytes, mode);
    if (linked.inode !== temporary.inode) {
      throw new EnvironmentMigrationError("concurrent-change");
    }
    if (!(await removeOwnedName(temporary))) {
      throw new UnrecoverableFileMutationError();
    }

    const installed = await readAndVerifyWrittenFile(expected.filePath, bytes, mode);
    if (backup) {
      await beforeBackupRemoval?.(backup.filePath);
      if (!(await removeOwnedName(backup))) {
        throw new UnrecoverableFileMutationError();
      }
    }
    return installed;
  } catch (error) {
    const recovered = await recoverFailedAtomicReplacement(
      expected,
      temporary,
      backup,
      committed,
      bytes,
      mode,
      beforeRecoveryRestore
    );
    if (!recovered) {
      throw new UnrecoverableFileMutationError();
    }
    if (error instanceof UnrecoverableFileMutationError) {
      throw error;
    }
    throw normalizeWriteFailure(error);
  }
}

async function createTemporaryFile(
  directory: string,
  bytes: Buffer,
  mode: number,
  afterWrite?: (temporaryPath: string) => Promise<void>
): Promise<ExistingFileSnapshot> {
  const filePath = createTemporaryPath(directory);
  let created = false;
  let handle;
  let createdIdentity: string | undefined;
  try {
    handle = await open(
      filePath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollowFlag,
      0o600
    );
    created = true;
    createdIdentity = identityOf(await handle.stat({ bigint: true }));
    await handle.writeFile(bytes);
    await handle.sync();
    if (supportsPosixPermissions) {
      await handle.chmod(mode);
    }
    createdIdentity = identityOf(await handle.stat({ bigint: true }));
    await handle.close();
    handle = undefined;
    await afterWrite?.(filePath);
    return await readAndVerifyWrittenFile(filePath, bytes, mode);
  } catch (error) {
    if (handle) {
      try {
        createdIdentity = identityOf(await handle.stat({ bigint: true }));
      } catch {
        createdIdentity = undefined;
      }
      await handle.close().catch(() => undefined);
    }
    if (!created) {
      throw normalizeWriteFailure(error);
    }
    if (!createdIdentity || !(await removeRawOwnedName(filePath, createdIdentity))) {
      throw new UnrecoverableFileMutationError();
    }
    throw normalizeWriteFailure(error);
  }
}

async function recoverFailedAtomicReplacement(
  expected: EnvironmentFileSnapshot,
  temporary: ExistingFileSnapshot,
  backup: ExistingFileSnapshot | undefined,
  committed: boolean,
  bytes: Buffer,
  mode: number,
  beforeRecoveryRestore?: (targetPath: string) => Promise<void>
): Promise<boolean> {
  const currentTarget = await tryReadSnapshot(expected.filePath);
  if (!currentTarget) {
    return false;
  }

  const targetHasReplacement = currentTarget.exists &&
    matchesInstalledFile(currentTarget, temporary, bytes, mode);
  if (!committed && targetHasReplacement) {
    committed = true;
  }

  if (committed) {
    if (!targetHasReplacement) {
      return false;
    }
    if (expected.exists) {
      if (!backup) {
        return false;
      }
      try {
        await assertExactSnapshot(backup);
        await beforeRecoveryRestore?.(expected.filePath);
        await assertExactSnapshot(currentTarget);
        await rename(backup.filePath, expected.filePath);
        backup = undefined;
        if (supportsPosixPermissions) {
          const restoredHandle = await open(
            expected.filePath,
            constants.O_RDONLY | noFollowFlag
          );
          try {
            await restoredHandle.chmod(expected.mode);
            await restoredHandle.sync();
          } finally {
            await restoredHandle.close();
          }
        }
        const restored = await readExactTextFile(expected.filePath);
        if (
          !restored.exists ||
          !restored.bytes.equals(expected.bytes) ||
          (supportsPosixPermissions && restored.mode !== expected.mode)
        ) {
          return false;
        }
      } catch {
        return false;
      }
    } else {
      try {
        await removeOwnedTarget(currentTarget);
      } catch {
        return false;
      }
    }
  } else if (backup && !(await removeOwnedName(backup))) {
    return false;
  }

  if (backup) {
    const remainingBackup = await tryReadSnapshot(backup.filePath);
    if (!remainingBackup) {
      return false;
    }
    if (remainingBackup.exists && !(await removeOwnedName(remainingBackup))) {
      return false;
    }
  }

  const remainingTemporary = await tryReadSnapshot(temporary.filePath);
  if (!remainingTemporary) {
    return false;
  }
  if (remainingTemporary.exists && !(await removeOwnedName(remainingTemporary))) {
    return false;
  }
  return true;
}

async function removeOwnedTarget(expected: ExistingFileSnapshot): Promise<void> {
  const quarantinePath = createTemporaryPath(path.dirname(expected.filePath));
  try {
    await assertExactSnapshot(expected);
    await rename(expected.filePath, quarantinePath);
    const moved = await readExactTextFile(quarantinePath);
    if (!moved.exists) {
      throw new EnvironmentMigrationError("rollback-failed");
    }
    if (!matchesMovedSnapshot(moved, expected)) {
      if (!(await restoreMovedSnapshot(moved, expected.filePath))) {
        throw new EnvironmentMigrationError("rollback-failed");
      }
      throw new EnvironmentMigrationError("rollback-failed");
    }
    if (!(await removeOwnedName(moved))) {
      throw new EnvironmentMigrationError("rollback-failed");
    }
    await assertMissing(expected.filePath);
  } catch (error) {
    const moved = await tryReadSnapshot(quarantinePath);
    if (moved?.exists) {
      await restoreMovedSnapshot(moved, expected.filePath);
    }
    if (error instanceof EnvironmentMigrationError) {
      throw error;
    }
    throw new EnvironmentMigrationError("rollback-failed", { cause: error });
  }
}

async function restoreMovedSnapshot(
  moved: ExistingFileSnapshot,
  targetPath: string
): Promise<boolean> {
  const target = await tryReadSnapshot(targetPath);
  if (!target) {
    return false;
  }
  if (target.exists) {
    return matchesMovedSnapshot(target, moved) && await removeOwnedName(moved);
  }

  try {
    await link(moved.filePath, targetPath);
    const restored = await readExactTextFile(targetPath);
    if (!restored.exists || !matchesMovedSnapshot(restored, moved)) {
      return false;
    }
    return await removeOwnedName(moved);
  } catch {
    return false;
  }
}

async function removeOwnedName(expected: ExistingFileSnapshot): Promise<boolean> {
  try {
    const current = await readExactTextFile(expected.filePath);
    if (!current.exists || !matchesMovedSnapshot(current, expected)) {
      return !current.exists;
    }
    await unlink(expected.filePath);
    await assertMissing(expected.filePath);
    return true;
  } catch {
    return false;
  }
}

async function removeRawOwnedName(filePath: string, expectedIdentity: string): Promise<boolean> {
  try {
    const current = await lstat(filePath, { bigint: true });
    if (identityOf(current) !== expectedIdentity) {
      return false;
    }
    await unlink(filePath);
    await assertMissing(filePath);
    return true;
  } catch (error) {
    return isFileSystemError(error, "ENOENT");
  }
}

async function tryReadSnapshot(filePath: string): Promise<EnvironmentFileSnapshot | undefined> {
  try {
    return await readExactTextFile(filePath);
  } catch {
    return undefined;
  }
}

function matchesInstalledFile(
  current: ExistingFileSnapshot,
  temporary: ExistingFileSnapshot,
  bytes: Buffer,
  mode: number
): boolean {
  return current.inode === temporary.inode &&
    current.bytes.equals(bytes) &&
    (!supportsPosixPermissions || current.mode === mode);
}

function matchesMovedSnapshot(
  current: ExistingFileSnapshot,
  expected: ExistingFileSnapshot
): boolean {
  return current.inode === expected.inode &&
    current.bytes.equals(expected.bytes) &&
    current.mode === expected.mode;
}

function createTemporaryPath(directory: string): string {
  return path.join(directory, `.safe-code-tmp-${randomBytes(16).toString("hex")}`);
}

function normalizeWriteFailure(error: unknown): EnvironmentMigrationError {
  if (error instanceof EnvironmentMigrationError) {
    return error;
  }
  return new EnvironmentMigrationError("write-failed", { cause: error });
}

async function readAndVerifyWrittenFile(
  filePath: string,
  bytes: Buffer,
  mode: number
): Promise<ExistingFileSnapshot> {
  const snapshot = await readExactTextFile(filePath);
  if (
    !snapshot.exists ||
    !snapshot.bytes.equals(bytes) ||
    (supportsPosixPermissions && snapshot.mode !== mode)
  ) {
    throw new EnvironmentMigrationError("write-failed");
  }
  return snapshot;
}

function identityOf(stat: {
  ctimeNs: bigint;
  dev: bigint;
  ino: bigint;
  mode: bigint;
  mtimeNs: bigint;
  size: bigint;
}): string {
  return [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
}

function inodeOf(stat: { dev: bigint; ino: bigint }): string {
  return `${stat.dev}:${stat.ino}`;
}

function workspaceIdentityOf(stat: { birthtimeNs: bigint; dev: bigint; ino: bigint }): string {
  return `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`;
}

async function inspectGitRepository(workspaceRoot: string): Promise<boolean> {
  const result = await runGit(workspaceRoot, ["rev-parse", "--is-inside-work-tree"]);
  if (result.code === 0 && result.stdout.trim() === "true") {
    return true;
  }
  if (result.code === 128 && result.stderr.includes("not a git repository")) {
    return false;
  }
  throw new EnvironmentMigrationError("git-unavailable");
}

async function assertEnvironmentUntracked(workspaceRoot: string): Promise<void> {
  const result = await runGit(workspaceRoot, ["ls-files", "--error-unmatch", "--", ".env"]);
  if (result.code === 0) {
    throw new EnvironmentMigrationError("tracked-environment");
  }
  if (result.code !== 1) {
    throw new EnvironmentMigrationError("git-unavailable");
  }
}

async function assertEnvironmentIgnored(workspaceRoot: string): Promise<void> {
  const result = await runGit(workspaceRoot, ["check-ignore", "--no-index", "--quiet", "--", ".env"]);
  if (result.code === 0) {
    return;
  }
  throw new EnvironmentMigrationError("git-unavailable");
}

async function assertTemporaryFilesIgnored(workspaceRoot: string): Promise<void> {
  const result = await runGit(workspaceRoot, [
    "check-ignore",
    "--no-index",
    "--quiet",
    "--",
    ".safe-code-tmp-probe"
  ]);
  if (result.code === 0) {
    return;
  }
  throw new EnvironmentMigrationError("git-unavailable");
}

async function runGit(workspaceRoot: string, args: string[]): Promise<GitResult> {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.toUpperCase().startsWith("GIT_"))
  );
  environment.LC_ALL = "C";
  return await new Promise<GitResult>((resolve, reject) => {
    execFile(
      "git",
      ["-C", workspaceRoot, ...args],
      {
        encoding: "utf8",
        env: environment,
        maxBuffer: 64 * 1024,
        timeout: 5_000,
        windowsHide: true
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ code: 0, stderr, stdout });
          return;
        }
        const code = (error as NodeJS.ErrnoException & { code?: number | string }).code;
        if (code === "ENOENT") {
          reject(new EnvironmentMigrationError("git-unavailable", { cause: error }));
          return;
        }
        resolve({ code: code ?? "UNKNOWN", stderr, stdout });
      }
    );
  });
}

function isFileSystemError(error: unknown, code: string): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}
