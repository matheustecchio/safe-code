import * as assert from "assert";
import { execFile } from "child_process";
import {
  chmod,
  link as hardLink,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  unlink,
  writeFile
} from "fs/promises";
import { tmpdir } from "os";
import * as path from "path";
import { promisify } from "util";
import {
  EnvironmentMigrationCoordinator,
  EnvironmentMigrationError,
  EnvironmentMigrationStep,
  EnvironmentMigrationTransaction,
  getEnvironmentMigrationMessage
} from "../../src/environmentMigrationCore";
import {
  assertSafeMigrationSource,
  EnvironmentStore,
  getEnvironmentWorkspaceIdentity
} from "../../src/environmentStore";

type EnvironmentFileStep = Exclude<EnvironmentMigrationStep, "source">;

const execFileAsync = promisify(execFile);
const environmentFiles = [".gitignore", ".env.example", ".env"] as const;
const fileForStep: Record<EnvironmentFileStep, (typeof environmentFiles)[number]> = {
  gitignore: ".gitignore",
  example: ".env.example",
  environment: ".env"
};
const redactionSentinel = ["synthetic", "private", "test", "value"].join("-");

suite("environment store", () => {
  test("creates protected environment files with exact bytes and modes", async () => {
    await withTemporaryWorkspace(async (workspaceRoot) => {
      const store = new EnvironmentStore(workspaceRoot);
      await applyEnvironmentFiles(store, "API_KEY", redactionSentinel);

      await assertFileBytes(workspaceRoot, ".gitignore", Buffer.from("/.safe-code-tmp-*\n/.env\n"));
      await assertFileBytes(workspaceRoot, ".env.example", Buffer.from("API_KEY=\n"));
      await assertFileBytes(
        workspaceRoot,
        ".env",
        Buffer.from(`API_KEY=${JSON.stringify(redactionSentinel)}\n`)
      );
      await assertFileMode(workspaceRoot, ".gitignore", 0o644);
      await assertFileMode(workspaceRoot, ".env.example", 0o644);
      await assertFileMode(workspaceRoot, ".env", 0o600);
    });
  });

  test("updates exact bytes, preserves public-file modes, and restricts .env", async () => {
    await withTemporaryWorkspace(async (workspaceRoot) => {
      await writeFileWithMode(workspaceRoot, ".gitignore", Buffer.from("node_modules/\r\n"), 0o640);
      await writeFileWithMode(workspaceRoot, ".env.example", Buffer.from("EXISTING=\r\n"), 0o604);
      await writeFileWithMode(
        workspaceRoot,
        ".env",
        Buffer.from('EXISTING="placeholder"\r\n'),
        0o644
      );

      const store = new EnvironmentStore(workspaceRoot);
      await applyEnvironmentFiles(store, "API_KEY", redactionSentinel);

      await assertFileBytes(
        workspaceRoot,
        ".gitignore",
        Buffer.from("node_modules/\r\n/.safe-code-tmp-*\r\n/.env\r\n")
      );
      await assertFileBytes(
        workspaceRoot,
        ".env.example",
        Buffer.from("EXISTING=\r\nAPI_KEY=\r\n")
      );
      await assertFileBytes(
        workspaceRoot,
        ".env",
        Buffer.from(`EXISTING="placeholder"\r\nAPI_KEY=${JSON.stringify(redactionSentinel)}\r\n`)
      );
      await assertFileMode(workspaceRoot, ".gitignore", 0o640);
      await assertFileMode(workspaceRoot, ".env.example", 0o604);
      await assertFileMode(workspaceRoot, ".env", 0o600);
    });
  });

  test("rejects a source symbolic link without changing the external target", async () => {
    await withTemporaryWorkspace(async (workspaceRoot, temporaryRoot) => {
      const outsidePath = path.join(temporaryRoot, "outside-source.ts");
      const sourcePath = path.join(workspaceRoot, "source.ts");
      const outsideBytes = Buffer.from('const apiKey = "external-source-secret";\n');
      await writeFile(outsidePath, outsideBytes);
      await symlink(outsidePath, sourcePath);

      const error = await expectMigrationError(
        () => assertSafeMigrationSource(workspaceRoot, sourcePath),
        "invalid-source"
      );

      assertSafeError(error);
      assert.strictEqual((await readFile(outsidePath)).equals(outsideBytes), true);
    });
  });

  test("rejects a hard-linked source without changing the external inode", async () => {
    await withTemporaryWorkspace(async (workspaceRoot, temporaryRoot) => {
      const outsidePath = path.join(temporaryRoot, "outside-hard-link.ts");
      const sourcePath = path.join(workspaceRoot, "source.ts");
      const outsideBytes = Buffer.from('const apiKey = "external-hard-link-secret";\n');
      await writeFile(outsidePath, outsideBytes);
      await hardLink(outsidePath, sourcePath);

      const error = await expectMigrationError(
        () => assertSafeMigrationSource(workspaceRoot, sourcePath),
        "invalid-source"
      );

      assertSafeError(error);
      assert.strictEqual((await readFile(outsidePath)).equals(outsideBytes), true);
    });
  });

  test("rejects a workspace root replaced after lock identity resolution", async () => {
    await withTemporaryWorkspace(async (workspaceRoot, temporaryRoot) => {
      const identity = await getEnvironmentWorkspaceIdentity(workspaceRoot);
      const originalRoot = path.join(temporaryRoot, "original-workspace");
      const replacementRoot = path.join(temporaryRoot, "replacement-workspace");
      await rename(workspaceRoot, originalRoot);
      await mkdir(replacementRoot);
      await symlink(replacementRoot, workspaceRoot);

      const error = await expectMigrationError(
        () => new EnvironmentStore(workspaceRoot, {}, identity.identity).prepare("API_KEY", redactionSentinel),
        "unsafe-target"
      );

      assertSafeError(error);
      assert.deepStrictEqual(await readdir(replacementRoot), []);
    });
  });

  test("rejects output that would exceed the validated target limit before writing", async () => {
    await withTemporaryWorkspace(async (workspaceRoot) => {
      const exactLimitBytes = Buffer.alloc(1_048_576, 0x23);
      await writeFile(path.join(workspaceRoot, ".env"), exactLimitBytes);

      const error = await expectMigrationError(
        () => new EnvironmentStore(workspaceRoot).prepare("API_KEY", redactionSentinel),
        "unsafe-target"
      );

      assertSafeError(error);
      await assertFileBytes(workspaceRoot, ".env", exactLimitBytes);
      await assertMissing(workspaceRoot, ".gitignore");
      await assertMissing(workspaceRoot, ".env.example");
    });
  });

  test("reports an initial temporary-open failure without inventing a mutation", async () => {
    if (process.platform === "win32") {
      return;
    }

    await withTemporaryWorkspace(async (workspaceRoot) => {
      const store = new EnvironmentStore(workspaceRoot);
      await store.prepare("API_KEY", redactionSentinel);
      await store.beforeStep("gitignore");
      await chmod(workspaceRoot, 0o500);
      let error: EnvironmentMigrationError;
      try {
        error = await expectMigrationError(
          () => store.apply("gitignore"),
          "write-failed"
        );
      } finally {
        await chmod(workspaceRoot, 0o700);
      }

      assertSafeError(error!);
      await assertMissing(workspaceRoot, ".gitignore");
      await assertMissing(workspaceRoot, ".env.example");
      await assertMissing(workspaceRoot, ".env");
    });
  });

  for (const target of environmentFiles) {
    test(`rejects a symbolic-link ${target} without changing its target`, async () => {
      await withTemporaryWorkspace(async (workspaceRoot, temporaryRoot) => {
        const outsidePath = path.join(temporaryRoot, `outside-${target.slice(1)}`);
        const outsideBytes = Buffer.from("outside-target-must-remain-unchanged\n");
        await writeFile(outsidePath, outsideBytes);
        await symlink(outsidePath, path.join(workspaceRoot, target));

        const error = await expectMigrationError(
          () => new EnvironmentStore(workspaceRoot).prepare("API_KEY", redactionSentinel),
          "unsafe-target"
        );

        assertSafeError(error);
        assert.strictEqual(
          (await readFile(outsidePath)).equals(outsideBytes),
          true,
          "The symbolic-link target changed."
        );
      });
    });

    test(`rejects a directory at ${target}`, async () => {
      await withTemporaryWorkspace(async (workspaceRoot) => {
        await mkdir(path.join(workspaceRoot, target));

        const error = await expectMigrationError(
          () => new EnvironmentStore(workspaceRoot).prepare("API_KEY", redactionSentinel),
          "unsafe-target"
        );

        assertSafeError(error);
      });
    });

    test(`rejects invalid UTF-8 at ${target}`, async () => {
      await withTemporaryWorkspace(async (workspaceRoot) => {
        await writeFile(path.join(workspaceRoot, target), Buffer.from([0xc3, 0x28]));

        const error = await expectMigrationError(
          () => new EnvironmentStore(workspaceRoot).prepare("API_KEY", redactionSentinel),
          "unsafe-target"
        );

        assertSafeError(error);
      });
    });
  }

  test("rejects a tracked .env in a real Git repository", async () => {
    await withTemporaryWorkspace(async (workspaceRoot) => {
      await initializeGitRepository(workspaceRoot);
      const originalBytes = Buffer.from("TRACKED_PLACEHOLDER=value\n");
      await writeFile(path.join(workspaceRoot, ".env"), originalBytes);
      await runGit(workspaceRoot, ["add", "-f", "--", ".env"]);

      const error = await expectMigrationError(
        () => new EnvironmentStore(workspaceRoot).prepare("API_KEY", redactionSentinel),
        "tracked-environment"
      );

      assertSafeError(error);
      await assertFileBytes(workspaceRoot, ".env", originalBytes);
      await assertMissing(workspaceRoot, ".gitignore");
      await assertMissing(workspaceRoot, ".env.example");
    });
  });

  test("fails closed when Git cannot be executed", async () => {
    await withTemporaryWorkspace(async (workspaceRoot) => {
      const previousPath = process.env.PATH;
      process.env.PATH = "";
      try {
        const error = await expectMigrationError(
          () => new EnvironmentStore(workspaceRoot).prepare("API_KEY", redactionSentinel),
          "git-unavailable"
        );
        assertSafeError(error);
      } finally {
        if (previousPath === undefined) {
          delete process.env.PATH;
        } else {
          process.env.PATH = previousPath;
        }
      }
    });
  });

  test("rejects a repository created after preparing an absent .env", async () => {
    await withTemporaryWorkspace(async (workspaceRoot) => {
      const store = new EnvironmentStore(workspaceRoot);
      await store.prepare("API_KEY", redactionSentinel);

      await initializeGitRepository(workspaceRoot);
      await writeFile(path.join(workspaceRoot, ".env"), "INDEX_PLACEHOLDER=value\n");
      await runGit(workspaceRoot, ["add", "-f", "--", ".env"]);
      await unlink(path.join(workspaceRoot, ".env"));

      const error = await expectMigrationError(
        () => store.beforeStep("gitignore"),
        "concurrent-change"
      );

      assertSafeError(error);
      await assertMissing(workspaceRoot, ".gitignore");
      await assertMissing(workspaceRoot, ".env.example");
      await assertMissing(workspaceRoot, ".env");
      const tracked = await execFileAsync(
        "git",
        ["-C", workspaceRoot, "ls-files", "--", ".env"],
        { env: { ...process.env, LC_ALL: "C" }, timeout: 5_000, windowsHide: true }
      );
      assert.strictEqual(tracked.stdout.trim(), ".env");
    });
  });

  test("ignores inherited Git index overrides when checking a tracked .env", async () => {
    await withTemporaryWorkspace(async (workspaceRoot, temporaryRoot) => {
      await initializeGitRepository(workspaceRoot);
      await writeFile(path.join(workspaceRoot, ".env"), "TRACKED_PLACEHOLDER=value\n");
      await runGit(workspaceRoot, ["add", "-f", "--", ".env"]);
      const alternateIndex = path.join(temporaryRoot, "alternate-index");
      await execFileAsync("git", ["-C", workspaceRoot, "read-tree", "--empty"], {
        env: { ...process.env, GIT_INDEX_FILE: alternateIndex, LC_ALL: "C" },
        timeout: 5_000,
        windowsHide: true
      });
      const previousIndex = process.env.GIT_INDEX_FILE;
      process.env.GIT_INDEX_FILE = alternateIndex;
      try {
        const error = await expectMigrationError(
          () => new EnvironmentStore(workspaceRoot).prepare("API_KEY", redactionSentinel),
          "tracked-environment"
        );
        assertSafeError(error);
      } finally {
        if (previousIndex === undefined) {
          delete process.env.GIT_INDEX_FILE;
        } else {
          process.env.GIT_INDEX_FILE = previousIndex;
        }
      }
    });
  });

  test("makes .env effectively ignored after a negating Git rule", async () => {
    await withTemporaryWorkspace(async (workspaceRoot) => {
      await initializeGitRepository(workspaceRoot);
      await writeFile(path.join(workspaceRoot, ".gitignore"), "/.env\n!/.env\n");
      await writeFile(path.join(workspaceRoot, ".env"), 'EXISTING="placeholder"\n');

      const store = new EnvironmentStore(workspaceRoot);
      await applyEnvironmentFiles(store, "API_KEY", redactionSentinel);

      await assertFileBytes(
        workspaceRoot,
        ".gitignore",
        Buffer.from("/.env\n!/.env\n/.safe-code-tmp-*\n/.env\n")
      );
      await runGit(workspaceRoot, ["check-ignore", "--no-index", "--quiet", "--", ".env"]);
      assert.strictEqual(
        (await readdir(workspaceRoot)).some((name) => name.startsWith(".safe-code-tmp-")),
        false,
        "A secret-bearing sibling temporary file was left in the workspace."
      );
    });
  });

  test("does not move a newly created .env when rollback protection is lost", async () => {
    await withTemporaryWorkspace(async (workspaceRoot) => {
      await initializeGitRepository(workspaceRoot);
      const unprotectedRules = Buffer.from("!/.env\n!/.safe-code-tmp-*\n");
      const store = new EnvironmentStore(workspaceRoot, {
        afterWrite: async (step) => {
          if (step === "environment") {
            await writeFile(path.join(workspaceRoot, ".gitignore"), unprotectedRules);
            throw new Error(redactionSentinel);
          }
        }
      });
      const transaction = createStoreTransaction(store, "API_KEY", redactionSentinel);

      const error = await expectMigrationError(
        () => new EnvironmentMigrationCoordinator().run(
          workspaceRoot,
          transaction,
          { isCancellationRequested: false }
        ),
        "rollback-failed"
      );

      assertSafeError(error);
      await assertFileBytes(workspaceRoot, ".gitignore", unprotectedRules);
      await assertMissing(workspaceRoot, ".env.example");
      await assertFileBytes(
        workspaceRoot,
        ".env",
        Buffer.from(`API_KEY=${JSON.stringify(redactionSentinel)}\n`)
      );
      assert.deepStrictEqual(
        (await readdir(workspaceRoot)).filter((name) => name.startsWith(".safe-code-tmp-")),
        [],
        "Rollback moved the environment secret to an unprotected temporary name."
      );
    });
  });

  test("does not restore a replaced backup over the installed .env", async () => {
    await withTemporaryWorkspace(async (workspaceRoot, temporaryRoot) => {
      await initializeGitRepository(workspaceRoot);
      await writeFile(
        path.join(workspaceRoot, ".gitignore"),
        "/.safe-code-tmp-*\n/.env\n"
      );
      const originalEnvironment = Buffer.from('EXISTING="placeholder"\n');
      await writeFileWithMode(workspaceRoot, ".env", originalEnvironment, 0o600);
      const externalPath = path.join(temporaryRoot, "foreign-backup-target");
      const externalBytes = Buffer.from("foreign-object-must-not-be-installed\n");
      await writeFile(externalPath, externalBytes);
      let replacedBackupPath: string | undefined;
      const store = new EnvironmentStore(workspaceRoot, {
        beforeBackupRemoval: async (step, backupPath) => {
          if (step === "environment") {
            replacedBackupPath = backupPath;
            await unlink(backupPath);
            await symlink(externalPath, backupPath);
          }
        }
      });

      const error = await expectMigrationError(
        () => new EnvironmentMigrationCoordinator().run(
          workspaceRoot,
          createStoreTransaction(store, "API_KEY", redactionSentinel),
          { isCancellationRequested: false }
        ),
        "rollback-failed"
      );

      assertSafeError(error);
      assert.ok(replacedBackupPath, "The environment backup was not intercepted.");
      assert.strictEqual((await lstat(replacedBackupPath)).isSymbolicLink(), true);
      await assertFileBytes(
        workspaceRoot,
        ".env",
        Buffer.from(`EXISTING="placeholder"\nAPI_KEY=${JSON.stringify(redactionSentinel)}\n`)
      );
      assert.strictEqual((await readFile(externalPath)).equals(externalBytes), true);
      await unlink(replacedBackupPath);
    });
  });

  test("does not overwrite a target changed while recovery validates its backup", async () => {
    await withTemporaryWorkspace(async (workspaceRoot) => {
      await initializeGitRepository(workspaceRoot);
      await writeFile(
        path.join(workspaceRoot, ".gitignore"),
        "/.safe-code-tmp-*\n/.env\n"
      );
      const originalEnvironment = Buffer.from('EXISTING="placeholder"\n');
      await writeFileWithMode(workspaceRoot, ".env", originalEnvironment, 0o600);
      const concurrentBytes = Buffer.from('CONCURRENT="must-remain"\n');
      let backupPath: string | undefined;
      const store = new EnvironmentStore(workspaceRoot, {
        beforeBackupRemoval: (step, currentBackupPath) => {
          if (step === "environment") {
            backupPath = currentBackupPath;
            throw new Error(redactionSentinel);
          }
        },
        beforeRecoveryRestore: async (step, targetPath) => {
          if (step === "environment") {
            await writeFile(targetPath, concurrentBytes);
          }
        }
      });

      const error = await expectMigrationError(
        () => new EnvironmentMigrationCoordinator().run(
          workspaceRoot,
          createStoreTransaction(store, "API_KEY", redactionSentinel),
          { isCancellationRequested: false }
        ),
        "rollback-failed"
      );

      assertSafeError(error);
      await assertFileBytes(workspaceRoot, ".env", concurrentBytes);
      assert.ok(backupPath, "The environment backup was not intercepted.");
      assert.strictEqual((await readFile(backupPath)).equals(originalEnvironment), true);
      await unlink(backupPath);
    });
  });

  test("retains Git protection when backup creation loses ownership", async () => {
    await withTemporaryWorkspace(async (workspaceRoot, temporaryRoot) => {
      await initializeGitRepository(workspaceRoot);
      const originalEnvironment = Buffer.from('EXISTING="protected-value"\n');
      await writeFileWithMode(workspaceRoot, ".env", originalEnvironment, 0o600);
      const externalPath = path.join(temporaryRoot, "foreign-backup-creation-target");
      const externalBytes = Buffer.from("foreign-object-must-remain-unchanged\n");
      await writeFile(externalPath, externalBytes);
      let orphanPath: string | undefined;
      const store = new EnvironmentStore(workspaceRoot, {
        afterTemporaryWrite: async (step, purpose, temporaryPath) => {
          if (step === "environment" && purpose === "backup") {
            orphanPath = temporaryPath;
            await unlink(temporaryPath);
            await symlink(externalPath, temporaryPath);
          }
        }
      });

      const error = await expectMigrationError(
        () => new EnvironmentMigrationCoordinator().run(
          workspaceRoot,
          createStoreTransaction(store, "API_KEY", redactionSentinel),
          { isCancellationRequested: false }
        ),
        "rollback-failed"
      );

      assertSafeError(error);
      await assertFileBytes(
        workspaceRoot,
        ".gitignore",
        Buffer.from("/.safe-code-tmp-*\n/.env\n")
      );
      await assertFileBytes(workspaceRoot, ".env", originalEnvironment);
      await assertMissing(workspaceRoot, ".env.example");
      assert.ok(orphanPath, "The backup-creation path was not intercepted.");
      assert.strictEqual((await lstat(orphanPath)).isSymbolicLink(), true);
      assert.strictEqual((await readFile(externalPath)).equals(externalBytes), true);
      await runGit(workspaceRoot, [
        "check-ignore",
        "--no-index",
        "--quiet",
        "--",
        path.basename(orphanPath)
      ]);
      await unlink(orphanPath);
    });
  });

  for (const step of ["gitignore", "example", "environment"] as const) {
    test(`detects a concurrent ${step} target change before writing`, async () => {
      await withTemporaryWorkspace(async (workspaceRoot) => {
        const foreignBytes = Buffer.from(`foreign-${step}-change\n`);
        const store = new EnvironmentStore(workspaceRoot, {
          beforeWrite: async (currentStep) => {
            if (currentStep === step) {
              await writeFile(path.join(workspaceRoot, fileForStep[step]), foreignBytes);
            }
          }
        });
        await store.prepare("API_KEY", redactionSentinel);
        await store.beforeStep(step);

        const error = await expectMigrationError(
          () => store.apply(step),
          "concurrent-change"
        );

        assertSafeError(error);
        await assertFileBytes(workspaceRoot, fileForStep[step], foreignBytes);
      });
    });

    test(`rolls back exact file state after a ${step} post-write failure`, async () => {
      await withTemporaryWorkspace(async (workspaceRoot) => {
        const originalGitignore = Buffer.from("dist/\r\n");
        const originalEnvironment = Buffer.from('EXISTING="placeholder"\r\n');
        await writeFileWithMode(workspaceRoot, ".gitignore", originalGitignore, 0o640);
        await writeFileWithMode(workspaceRoot, ".env", originalEnvironment, 0o600);

        const store = new EnvironmentStore(workspaceRoot, {
          afterWrite: (currentStep) => {
            if (currentStep === step) {
              throw new Error(redactionSentinel);
            }
          }
        });
        const transaction = createStoreTransaction(store, "API_KEY", redactionSentinel);
        const coordinator = new EnvironmentMigrationCoordinator();

        const error = await expectMigrationError(
          () => coordinator.run(workspaceRoot, transaction, { isCancellationRequested: false }),
          "write-failed"
        );

        assertSafeError(error);
        await assertFileBytes(workspaceRoot, ".gitignore", originalGitignore);
        await assertFileMode(workspaceRoot, ".gitignore", 0o640);
        await assertMissing(workspaceRoot, ".env.example");
        await assertFileBytes(workspaceRoot, ".env", originalEnvironment);
        await assertFileMode(workspaceRoot, ".env", 0o600);
      });
    });
  }
});

async function withTemporaryWorkspace(
  callback: (workspaceRoot: string, temporaryRoot: string) => Promise<void>
): Promise<void> {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "safe-code-environment-store-"));
  const workspaceRoot = path.join(temporaryRoot, "workspace");
  await mkdir(workspaceRoot);

  try {
    await callback(workspaceRoot, temporaryRoot);
    await assertNoTemporaryFiles(workspaceRoot);
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
}

async function applyEnvironmentFiles(
  store: EnvironmentStore,
  environmentVariableName: string,
  secretValue: string
): Promise<void> {
  await store.prepare(environmentVariableName, secretValue);
  for (const step of ["gitignore", "example", "environment"] as const) {
    await store.beforeStep(step);
    await store.apply(step);
  }
  await store.beforeStep("source");
  await store.verify();
}

function createStoreTransaction(
  store: EnvironmentStore,
  environmentVariableName: string,
  secretValue: string
): EnvironmentMigrationTransaction {
  return {
    prepare: async () => store.prepare(environmentVariableName, secretValue),
    beforeStep: async (step) => store.beforeStep(step),
    apply: async (step) => step === "source" ? undefined : store.apply(step),
    verify: async () => store.verify()
  };
}

async function expectMigrationError(
  operation: () => Promise<unknown>,
  expectedCode: EnvironmentMigrationError["code"]
): Promise<EnvironmentMigrationError> {
  let caught: unknown;
  try {
    await operation();
  } catch (error) {
    caught = error;
  }

  if (!(caught instanceof EnvironmentMigrationError)) {
    throw new Error("Expected a typed environment migration error.");
  }
  assert.strictEqual(caught.code, expectedCode, "The migration used an unexpected safe error code.");
  return caught;
}

function assertSafeError(error: EnvironmentMigrationError): void {
  for (const rendered of [error.message, error.name, String(error), getEnvironmentMigrationMessage(error)]) {
    assert.strictEqual(
      rendered.includes(redactionSentinel),
      false,
      "A rendered migration error exposed the protected test value."
    );
  }
}

async function initializeGitRepository(workspaceRoot: string): Promise<void> {
  await runGit(workspaceRoot, ["init", "--quiet"]);
}

async function runGit(workspaceRoot: string, args: string[]): Promise<void> {
  await execFileAsync("git", ["-C", workspaceRoot, ...args], {
    env: { ...process.env, LC_ALL: "C" },
    timeout: 5_000,
    windowsHide: true
  });
}

async function writeFileWithMode(
  workspaceRoot: string,
  fileName: string,
  bytes: Buffer,
  mode: number
): Promise<void> {
  const filePath = path.join(workspaceRoot, fileName);
  await writeFile(filePath, bytes, { mode });
  await chmod(filePath, mode);
}

async function assertFileBytes(
  workspaceRoot: string,
  fileName: string,
  expected: Buffer
): Promise<void> {
  const actual = await readFile(path.join(workspaceRoot, fileName));
  assert.strictEqual(actual.equals(expected), true, `${fileName} did not have the expected exact bytes.`);
}

async function assertFileMode(
  workspaceRoot: string,
  fileName: string,
  expectedMode: number
): Promise<void> {
  if (process.platform === "win32") {
    return;
  }
  const fileStat = await lstat(path.join(workspaceRoot, fileName));
  assert.strictEqual(fileStat.mode & 0o777, expectedMode, `${fileName} did not preserve its mode.`);
}

async function assertMissing(workspaceRoot: string, fileName: string): Promise<void> {
  try {
    await lstat(path.join(workspaceRoot, fileName));
  } catch (error) {
    if (error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw new Error(`Could not verify that ${fileName} was absent.`);
  }
  throw new Error(`${fileName} should be absent.`);
}

async function assertNoTemporaryFiles(workspaceRoot: string): Promise<void> {
  const names = await readdir(workspaceRoot);
  assert.strictEqual(
    names.some((name) => name.startsWith(".safe-code-tmp-")),
    false,
    "A migration temporary file was left behind."
  );
}
