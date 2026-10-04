import * as assert from "assert";
import { mkdtemp, mkdir, lstat, readFile, readdir, rename, rm, stat, symlink, writeFile } from "fs/promises";
import * as os from "os";
import * as path from "path";
import { createIgnoredWarning, serializeProjectIgnoreConfig } from "../../src/ignoreCore";
import {
  addProjectIgnoredWarning,
  getProjectIgnoreFileErrorMessage,
  normalizeProjectIgnoreFileError,
  ProjectIgnoreFileError,
  ProjectIgnoreFileErrorCode,
  readProjectIgnoreConfigFile,
  readProjectIgnoreFileSnapshot,
  writeProjectIgnoreFile
} from "../../src/projectIgnoreFile";

suite("project ignore file", () => {
  let temporaryRoot: string;
  let workspaceRoot: string;
  let configPath: string;

  setup(async () => {
    temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "safe-code-project-ignore-"));
    workspaceRoot = path.join(temporaryRoot, "workspace");
    configPath = path.join(workspaceRoot, ".vscode", ".safe-code.json");
    await mkdir(path.dirname(configPath), { recursive: true });
  });

  teardown(async () => {
    await rm(temporaryRoot, { force: true, recursive: true });
  });

  test("creates a missing configuration exclusively with restrictive permissions", async () => {
    await rm(path.dirname(configPath), { recursive: true });
    assert.deepStrictEqual(await readProjectIgnoreConfigFile(configPath), { version: 1, ignoredWarnings: [] });
    const warning = createIgnoredWarning("src/missing.ts", "const token = secret;", "generic-secret-assignment");

    const update = await addProjectIgnoredWarning(configPath, warning);

    assert.strictEqual(update.changed, true);
    assert.deepStrictEqual(update.config, { version: 1, ignoredWarnings: [warning] });
    assert.deepStrictEqual(await readProjectIgnoreConfigFile(configPath), update.config);
    if (process.platform !== "win32") {
      assert.strictEqual((await stat(configPath)).mode & 0o777, 0o600);
    }
  });

  test("keeps workspace folders isolated and preserves existing editor settings", async () => {
    const otherConfig = path.join(temporaryRoot, "other-workspace", ".vscode", ".safe-code.json");
    await mkdir(path.dirname(otherConfig), { recursive: true });
    const settingsPath = path.join(path.dirname(configPath), "settings.json");
    await writeFile(settingsPath, '{"editor.tabSize":2}');
    const warning = createIgnoredWarning("src/a.ts", "secret", "rule");
    await addProjectIgnoredWarning(configPath, warning);
    assert.deepStrictEqual(await readProjectIgnoreConfigFile(otherConfig), { version: 1, ignoredWarnings: [] });
    assert.strictEqual(await readFile(settingsPath, "utf8"), '{"editor.tabSize":2}');
  });

  test("atomically replaces a valid regular configuration and preserves its mode", async () => {
    const firstWarning = createIgnoredWarning("src/z.ts", "const token = first;", "generic-secret-assignment");
    const secondWarning = createIgnoredWarning("src/a.ts", "const token = second;", "generic-secret-assignment");
    await writeFile(
      configPath,
      serializeProjectIgnoreConfig({ version: 1, ignoredWarnings: [firstWarning] }),
      { encoding: "utf8", mode: 0o640 }
    );
    const originalStat = await stat(configPath);

    const update = await addProjectIgnoredWarning(configPath, secondWarning);

    assert.strictEqual(update.changed, true);
    assert.deepStrictEqual(update.config.ignoredWarnings, [secondWarning, firstWarning]);
    assert.deepStrictEqual(await readProjectIgnoreConfigFile(configPath), update.config);
    const updatedStat = await stat(configPath);
    if (process.platform !== "win32") {
      assert.strictEqual(updatedStat.mode & 0o777, originalStat.mode & 0o777);
      assert.notStrictEqual(updatedStat.ino, originalStat.ino);
    }
    assert.deepStrictEqual(await readdir(path.dirname(configPath)), [".safe-code.json"]);
  });

  test("rejects invalid configuration without exposing or changing its bytes", async () => {
    const invalidBytes = Buffer.from('{"privateValue":"do-not-expose"}\n', "utf8");
    await writeFile(configPath, invalidBytes);

    await assertProjectIgnoreFileError(
      addProjectIgnoredWarning(
        configPath,
        createIgnoredWarning("src/invalid.ts", "const token = invalid;", "generic-secret-assignment")
      ),
      "invalid-configuration",
      ["do-not-expose", temporaryRoot]
    );

    assert.deepStrictEqual(await readFile(configPath), invalidBytes);
  });

  test("never follows a symbolic link or changes its target outside the workspace", async () => {
    const outsidePath = path.join(temporaryRoot, "outside.json");
    const outsideBytes = Buffer.from(
      serializeProjectIgnoreConfig({
        version: 1,
        ignoredWarnings: [
          createIgnoredWarning("src/outside.ts", "const token = outside;", "generic-secret-assignment")
        ]
      }),
      "utf8"
    );
    await writeFile(outsidePath, outsideBytes);
    await symlink(outsidePath, configPath);

    await assertProjectIgnoreFileError(readProjectIgnoreConfigFile(configPath), "unsafe-target", [outsidePath]);
    await assertProjectIgnoreFileError(
      addProjectIgnoredWarning(
        configPath,
        createIgnoredWarning("src/link.ts", "const token = linked;", "generic-secret-assignment")
      ),
      "unsafe-target",
      [outsidePath]
    );

    assert.strictEqual((await lstat(configPath)).isSymbolicLink(), true);
    assert.deepStrictEqual(await readFile(outsidePath), outsideBytes);
  });

  test("rejects a symlinked parent without reading or writing outside the workspace", async () => {
    const parent = path.dirname(configPath);
    const outside = path.join(temporaryRoot, "outside");
    await mkdir(outside);
    const outsideConfig = path.join(outside, ".safe-code.json");
    const bytes = Buffer.from(serializeProjectIgnoreConfig({ version: 1, ignoredWarnings: [] }));
    await writeFile(outsideConfig, bytes);
    await rm(parent, { recursive: true });
    await symlink(outside, parent, "dir");
    await assertProjectIgnoreFileError(readProjectIgnoreConfigFile(configPath), "unsafe-target", [outside]);
    await assertProjectIgnoreFileError(
      addProjectIgnoredWarning(configPath, createIgnoredWarning("src/a.ts", "secret", "rule")),
      "unsafe-target", [outside]
    );
    assert.deepStrictEqual(await readFile(outsideConfig), bytes);
    assert.deepStrictEqual(await readdir(outside), [".safe-code.json"]);
  });

  test("rejects a file in place of the parent directory", async () => {
    await rm(path.dirname(configPath), { recursive: true });
    await writeFile(path.dirname(configPath), "preserve me");
    await assertProjectIgnoreFileError(readProjectIgnoreConfigFile(configPath), "unsafe-target", []);
    await assertProjectIgnoreFileError(
      addProjectIgnoredWarning(configPath, createIgnoredWarning("src/a.ts", "secret", "rule")),
      "unsafe-target", []
    );
  });

  test("rejects parent replacement after a snapshot, including when the file is missing", async () => {
    for (const exists of [false, true]) {
      if (exists) {
        await writeFile(configPath, serializeProjectIgnoreConfig({ version: 1, ignoredWarnings: [] }));
      }
      const snapshot = await readProjectIgnoreFileSnapshot(configPath);
      await rename(path.dirname(configPath), path.join(workspaceRoot, `old-${exists}`));
      await mkdir(path.dirname(configPath));
      await assertProjectIgnoreFileError(
        writeProjectIgnoreFile(configPath, snapshot, Buffer.from('{"version":1,"ignoredWarnings":[]}')),
        "concurrent-modification", []
      );
      assert.deepStrictEqual(await readdir(path.dirname(configPath)), []);
    }
  });

  test("rejects a directory as a non-regular configuration target", async () => {
    await mkdir(configPath);

    await assertProjectIgnoreFileError(readProjectIgnoreConfigFile(configPath), "unsafe-target", [temporaryRoot]);

    assert.strictEqual((await lstat(configPath)).isDirectory(), true);
  });

  test("rejects concurrent modification before replacing an existing file", async () => {
    const originalBytes = Buffer.from(
      serializeProjectIgnoreConfig({ version: 1, ignoredWarnings: [] }),
      "utf8"
    );
    const concurrentBytes = Buffer.from(
      serializeProjectIgnoreConfig({
        version: 1,
        ignoredWarnings: [
          createIgnoredWarning("src/concurrent.ts", "const token = concurrent;", "generic-secret-assignment")
        ]
      }),
      "utf8"
    );
    await writeFile(configPath, originalBytes);
    const snapshot = await readProjectIgnoreFileSnapshot(configPath);
    await writeFile(configPath, concurrentBytes);

    await assertProjectIgnoreFileError(
      writeProjectIgnoreFile(configPath, snapshot, Buffer.from('{"version":1,"ignoredWarnings":[]}\n')),
      "concurrent-modification",
      [temporaryRoot]
    );

    assert.deepStrictEqual(await readFile(configPath), concurrentBytes);
    assert.deepStrictEqual(await readdir(path.dirname(configPath)), [".safe-code.json"]);
  });

  test("does not replace a path created after a missing snapshot", async () => {
    const snapshot = await readProjectIgnoreFileSnapshot(configPath);
    const concurrentBytes = Buffer.from("concurrent owner\n", "utf8");
    await writeFile(configPath, concurrentBytes);

    await assertProjectIgnoreFileError(
      writeProjectIgnoreFile(configPath, snapshot, Buffer.from('{"version":1,"ignoredWarnings":[]}\n')),
      "concurrent-modification",
      ["concurrent owner", temporaryRoot]
    );

    assert.deepStrictEqual(await readFile(configPath), concurrentBytes);
  });

  test("derives boundary messages from typed codes instead of trusting error text", () => {
    const injectedError = new ProjectIgnoreFileError("unsafe-target", "do-not-expose");

    const message = getProjectIgnoreFileErrorMessage(injectedError, "read-failed");
    const normalized = normalizeProjectIgnoreFileError(injectedError, "read-failed");

    assert.ok(!message.includes("do-not-expose"));
    assert.ok(!normalized.message.includes("do-not-expose"));
    assert.strictEqual(normalized.code, "unsafe-target");
  });
});

async function assertProjectIgnoreFileError(
  operation: Promise<unknown>,
  expectedCode: ProjectIgnoreFileErrorCode,
  forbiddenMessageParts: string[]
): Promise<void> {
  await assert.rejects(operation, (error: unknown) => {
    assert.ok(error instanceof ProjectIgnoreFileError);
    assert.strictEqual(error.code, expectedCode);
    for (const forbiddenPart of forbiddenMessageParts) {
      assert.ok(!error.message.includes(forbiddenPart), `Error message exposed ${forbiddenPart}`);
    }
    return true;
  });
}
