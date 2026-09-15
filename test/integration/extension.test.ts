import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import type { WorkspaceScanResult } from "../../src/extension";
import { hashLineText } from "../../src/ignoreCore";
import {
  DEFAULT_MAX_FILE_SIZE_BYTES,
  DEFAULT_MAX_WORKSPACE_SCAN_BYTES,
  DEFAULT_MAX_WORKSPACE_SCAN_FILES
} from "../../src/workspaceScanCore";

const extensionId = "matheus-tecchio.safe-code";
const runtimeDirectoryName = "runtime";
const defaultIgnoredPaths = [
  "**/node_modules/**",
  "**/.git/**",
  "**/dist/**",
  "**/build/**",
  "**/coverage/**",
  "**/vendor/**",
  "**/target/**",
  "**/.cache/**"
];

suite("Safe Code extension", () => {
  let workspaceRoot: vscode.Uri;
  let runtimeDirectory: vscode.Uri;
  let projectConfigUri: vscode.Uri;
  let environmentUri: vscode.Uri;
  let environmentExampleUri: vscode.Uri;
  let gitIgnoreUri: vscode.Uri;
  let createdWorkspaceFiles: vscode.Uri[] = [];

  suiteSetup(async () => {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(workspaceFolder, "The integration fixture workspace must be open");
    workspaceRoot = workspaceFolder.uri;
    runtimeDirectory = vscode.Uri.joinPath(workspaceRoot, runtimeDirectoryName);
    projectConfigUri = vscode.Uri.joinPath(workspaceRoot, ".safe-code.json");
    environmentUri = vscode.Uri.joinPath(workspaceRoot, ".env");
    environmentExampleUri = vscode.Uri.joinPath(workspaceRoot, ".env.example");
    gitIgnoreUri = vscode.Uri.joinPath(workspaceRoot, ".gitignore");
    await vscode.workspace.fs.createDirectory(runtimeDirectory);

    const extension = vscode.extensions.getExtension(extensionId);
    assert.ok(extension, `Extension ${extensionId} was not found`);
    await extension.activate();
  });

  setup(async () => {
    const configuration = vscode.workspace.getConfiguration("safeCode");
    await configuration.update("enabled", true, vscode.ConfigurationTarget.Global);
    await configuration.update("scanWorkspaceOnStartup", false, vscode.ConfigurationTarget.Global);
    await configuration.update("minimumSecretLength", 8, vscode.ConfigurationTarget.Global);
    await configuration.update("maxFileSizeBytes", DEFAULT_MAX_FILE_SIZE_BYTES, vscode.ConfigurationTarget.Global);
    await configuration.update(
      "maxWorkspaceScanFiles",
      DEFAULT_MAX_WORKSPACE_SCAN_FILES,
      vscode.ConfigurationTarget.Global
    );
    await configuration.update(
      "maxWorkspaceScanBytes",
      DEFAULT_MAX_WORKSPACE_SCAN_BYTES,
      vscode.ConfigurationTarget.Global
    );
    await configuration.update("ignoredPaths", defaultIgnoredPaths, vscode.ConfigurationTarget.Global);
  });

  teardown(async () => {
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    for (const uri of createdWorkspaceFiles) {
      await vscode.workspace.fs.delete(uri, { useTrash: false });
    }
    createdWorkspaceFiles = [];
    await deleteIfExists(projectConfigUri);
    await deleteIfExists(environmentUri);
    await deleteIfExists(environmentExampleUri);
    await deleteIfExists(gitIgnoreUri);
    await vscode.commands.executeCommand("safeCode.scanWorkspace");
  });

  suiteTeardown(async () => {
    const configuration = vscode.workspace.getConfiguration("safeCode");
    await configuration.update("enabled", undefined, vscode.ConfigurationTarget.Global);
    await configuration.update("scanWorkspaceOnStartup", undefined, vscode.ConfigurationTarget.Global);
    await configuration.update("minimumSecretLength", undefined, vscode.ConfigurationTarget.Global);
    await configuration.update("maxFileSizeBytes", undefined, vscode.ConfigurationTarget.Global);
    await configuration.update("maxWorkspaceScanFiles", undefined, vscode.ConfigurationTarget.Global);
    await configuration.update("maxWorkspaceScanBytes", undefined, vscode.ConfigurationTarget.Global);
    await configuration.update("ignoredPaths", undefined, vscode.ConfigurationTarget.Global);
    await vscode.workspace.fs.delete(runtimeDirectory, { recursive: true, useTrash: false });
  });

  test("activates and creates diagnostics for a suspicious file", async () => {
    const uri = await createWorkspaceFile("diagnostic.ts", 'const apiKey = "integration-secret-value";');
    await vscode.window.showTextDocument(uri);
    await vscode.commands.executeCommand("safeCode.scanOpenFiles");

    const diagnostics = await eventually(() => getSafeCodeDiagnostics(uri), (items) => items.length === 1);
    assert.strictEqual(diagnostics[0].source, "Safe Code");
    assert.strictEqual(diagnostics[0].code, "generic-secret-assignment");

    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    assert.strictEqual(getSafeCodeDiagnostics(uri).length, 1);
  });

  test("automatically maintains diagnostics for workspace file changes", async () => {
    const uri = await createWorkspaceFile("watched.ts", 'const apiKey = "watched-secret-value";');
    await eventually(() => getSafeCodeDiagnostics(uri), (items) => items.length === 1);

    await vscode.workspace.fs.writeFile(uri, Buffer.from("export const clean = true;"));
    await eventually(() => getSafeCodeDiagnostics(uri), (items) => items.length === 0);

    await vscode.workspace.fs.writeFile(uri, Buffer.from('const token = "watched-secret-again";'));
    await eventually(() => getSafeCodeDiagnostics(uri), (items) => items.length === 1);

    await vscode.workspace.fs.delete(uri, { useTrash: false });
    createdWorkspaceFiles = createdWorkspaceFiles.filter((candidate) => candidate.toString() !== uri.toString());
    await eventually(() => getSafeCodeDiagnostics(uri), (items) => items.length === 0);
  });

  test("automatically scans workspace files when startup scanning is enabled", async () => {
    const configuration = vscode.workspace.getConfiguration("safeCode");
    await configuration.update("enabled", false, vscode.ConfigurationTarget.Global);
    const uri = await createWorkspaceFile("startup.ts", 'const apiKey = "startup-secret-value";');
    assert.deepStrictEqual(getSafeCodeDiagnostics(uri), []);

    await configuration.update("scanWorkspaceOnStartup", true, vscode.ConfigurationTarget.Global);
    await configuration.update("enabled", true, vscode.ConfigurationTarget.Global);

    const diagnostics = await eventually(() => getSafeCodeDiagnostics(uri), (items) => items.length === 1);
    assert.strictEqual(diagnostics[0].code, "generic-secret-assignment");
  });

  test("registers the workspace command and diagnoses an unopened file", async () => {
    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes("safeCode.scanWorkspace"));

    const extension = vscode.extensions.getExtension(extensionId);
    const menus = extension?.packageJSON.contributes?.menus;
    assert.ok(
      menus?.["editor/title/context"]?.some(
        (item: { command?: string }) => item.command === "safeCode.scanWorkspace"
      )
    );

    const uri = await createWorkspaceFile("unopened.ts", 'const apiKey = "workspace-secret-value";');
    assert.strictEqual(vscode.workspace.textDocuments.some((document) => document.uri.toString() === uri.toString()), false);

    await vscode.commands.executeCommand("safeCode.scanWorkspace");
    const diagnostics = await eventually(() => getSafeCodeDiagnostics(uri), (items) => items.length === 1);
    assert.strictEqual(diagnostics[0].code, "generic-secret-assignment");

    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    assert.strictEqual(getSafeCodeDiagnostics(uri).length, 1);
  });

  test("skips an oversized closed file before opening it", async () => {
    const configuration = vscode.workspace.getConfiguration("safeCode");
    await configuration.update("enabled", false, vscode.ConfigurationTarget.Global);
    const content = 'const apiKey = "oversized-workspace-secret";';
    const uri = await createWorkspaceFile("oversized.ts", content);
    assert.strictEqual(isDocumentOpen(uri), false);

    await configuration.update("maxFileSizeBytes", Buffer.byteLength(content) - 1, vscode.ConfigurationTarget.Global);
    await configuration.update("enabled", true, vscode.ConfigurationTarget.Global);
    const result = await vscode.commands.executeCommand<WorkspaceScanResult>("safeCode.scanWorkspace");

    assert.ok(result);
    assert.strictEqual(result.oversizedFiles, 1);
    assert.strictEqual(result.scannedFiles, 0);
    assert.strictEqual(result.scannedBytes, 0);
    assert.strictEqual(result.partial, false);
    assert.strictEqual(isDocumentOpen(uri), false);
    assert.deepStrictEqual(getSafeCodeDiagnostics(uri), []);
  });

  test("accepts a closed file exactly at the configured byte limit", async () => {
    const configuration = vscode.workspace.getConfiguration("safeCode");
    await configuration.update("enabled", false, vscode.ConfigurationTarget.Global);
    const content = 'const apiKey = "exact-byte-limit-secret";';
    const byteLength = Buffer.byteLength(content);
    const uri = await createWorkspaceFile("exact-limit.ts", content);
    assert.strictEqual(isDocumentOpen(uri), false);

    await configuration.update("maxFileSizeBytes", byteLength, vscode.ConfigurationTarget.Global);
    await configuration.update("enabled", true, vscode.ConfigurationTarget.Global);
    const result = await vscode.commands.executeCommand<WorkspaceScanResult>("safeCode.scanWorkspace");

    assert.ok(result);
    assert.strictEqual(result.oversizedFiles, 0);
    assert.strictEqual(result.scannedFiles, 1);
    assert.strictEqual(result.scannedBytes, byteLength);
    assert.strictEqual(result.partial, false);
    await eventually(() => getSafeCodeDiagnostics(uri), (items) => items.length === 1);
  });

  test("uses current UTF-8 bytes for an open dirty document", async () => {
    const configuration = vscode.workspace.getConfiguration("safeCode");
    await configuration.update("enabled", false, vscode.ConfigurationTarget.Global);
    const uri = await createWorkspaceFile("dirty-size.ts", "x".repeat(4096));
    const document = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(document);
    const dirtyContent = 'const apiKey = "dirty-é-secret-value";';
    const dirtyByteLength = Buffer.byteLength(dirtyContent, "utf8");
    assert.ok(
      await editor.edit((builder) => {
        builder.replace(
          new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)),
          dirtyContent
        );
      })
    );
    assert.strictEqual(document.isDirty, true);
    assert.ok((await vscode.workspace.fs.stat(uri)).size > dirtyByteLength);

    await configuration.update("maxFileSizeBytes", dirtyByteLength, vscode.ConfigurationTarget.Global);
    await configuration.update("enabled", true, vscode.ConfigurationTarget.Global);
    const result = await vscode.commands.executeCommand<WorkspaceScanResult>("safeCode.scanWorkspace");

    assert.ok(result);
    assert.strictEqual(result.oversizedFiles, 0);
    assert.strictEqual(result.scannedFiles, 1);
    assert.strictEqual(result.scannedBytes, dirtyByteLength);
    await eventually(() => getSafeCodeDiagnostics(uri), (items) => items.length === 1);
    await document.save();
  });

  test("discovers uppercase supported files and environment variants", async () => {
    const configuration = vscode.workspace.getConfiguration("safeCode");
    await configuration.update("enabled", false, vscode.ConfigurationTarget.Global);
    const typescriptUri = await createWorkspaceFileWithExactBaseName(
      "UPPER.TS",
      'const apiKey = "uppercase-typescript-secret";'
    );
    const environmentVariantUri = await createWorkspaceFileWithExactBaseName(
      ".ENV.local",
      "API_TOKEN=uppercase-environment-secret"
    );

    await configuration.update("enabled", true, vscode.ConfigurationTarget.Global);
    const result = await vscode.commands.executeCommand<WorkspaceScanResult>("safeCode.scanWorkspace");

    assert.ok(result);
    assert.strictEqual(result.scannedFiles, 2);
    await eventually(() => getSafeCodeDiagnostics(typescriptUri), (items) => items.length === 1);
    await eventually(() => getSafeCodeDiagnostics(environmentVariantUri), (items) => items.length === 1);
  });

  test("returns a partial result when the workspace file budget is reached", async () => {
    const configuration = vscode.workspace.getConfiguration("safeCode");
    await configuration.update("enabled", false, vscode.ConfigurationTarget.Global);
    await createWorkspaceFile("file-limit-a.ts", 'const apiKey = "first-file-limit-secret";');
    await createWorkspaceFile("file-limit-b.ts", 'const apiKey = "second-file-limit-secret";');

    await configuration.update("maxWorkspaceScanFiles", 1, vscode.ConfigurationTarget.Global);
    await configuration.update("enabled", true, vscode.ConfigurationTarget.Global);
    const result = await vscode.commands.executeCommand<WorkspaceScanResult>("safeCode.scanWorkspace");

    assert.ok(result);
    assert.strictEqual(result.partial, true);
    assert.strictEqual(result.partialReason, "file-limit");
    assert.strictEqual(result.scannedFiles, 1);
  });

  test("returns a partial result when the workspace byte budget is reached", async () => {
    const configuration = vscode.workspace.getConfiguration("safeCode");
    await configuration.update("enabled", false, vscode.ConfigurationTarget.Global);
    const content = 'const apiKey = "equal-sized-byte-budget-secret";';
    const byteLength = Buffer.byteLength(content);
    await createWorkspaceFile("byte-limit-a.ts", content);
    await createWorkspaceFile("byte-limit-b.ts", content);

    await configuration.update("maxWorkspaceScanBytes", byteLength, vscode.ConfigurationTarget.Global);
    await configuration.update("enabled", true, vscode.ConfigurationTarget.Global);
    const result = await vscode.commands.executeCommand<WorkspaceScanResult>("safeCode.scanWorkspace");

    assert.ok(result);
    assert.strictEqual(result.partial, true);
    assert.strictEqual(result.partialReason, "byte-limit");
    assert.strictEqual(result.scannedFiles, 1);
    assert.strictEqual(result.scannedBytes, byteLength);
  });

  test("removes a stale diagnostic when a file grows above the byte limit", async () => {
    const maximumBytes = 64;
    const initialContent = 'const apiKey = "initial-size-secret";';
    const uri = await createWorkspaceFile("grows-oversized.ts", initialContent);
    await eventually(() => getSafeCodeDiagnostics(uri), (items) => items.length === 1);

    const configuration = vscode.workspace.getConfiguration("safeCode");
    await configuration.update("maxFileSizeBytes", maximumBytes, vscode.ConfigurationTarget.Global);
    await eventually(() => getSafeCodeDiagnostics(uri), (items) => items.length === 1);

    const prefix = 'const apiKey = "';
    const suffix = '";';
    const oversizedContent = `${prefix}${"x".repeat(maximumBytes + 1 - Buffer.byteLength(prefix + suffix))}${suffix}`;
    assert.strictEqual(Buffer.byteLength(oversizedContent), maximumBytes + 1);
    await vscode.workspace.fs.writeFile(uri, Buffer.from(oversizedContent));

    await eventually(() => getSafeCodeDiagnostics(uri), (items) => items.length === 0);
  });

  test("workspace scan honors default and custom ignored paths", async () => {
    const dependencyUri = await createWorkspaceFile(
      "node_modules/example/dependency.ts",
      'const apiKey = "dependency-secret-value";',
      { waitForCreateEvent: false }
    );
    const generatedUri = await createWorkspaceFile(
      "generated/output.ts",
      'const apiKey = "generated-secret-value";'
    );
    const supportedUri = await createWorkspaceFile("source.ts", 'const apiKey = "source-secret-value";');
    const unsupportedUri = await createWorkspaceFile("notes.txt", 'const apiKey = "unsupported-secret-value";');

    const configuration = vscode.workspace.getConfiguration("safeCode");
    await configuration.update("ignoredPaths", ["**/generated/**"], vscode.ConfigurationTarget.Global);
    await vscode.commands.executeCommand("safeCode.scanWorkspace");

    assert.deepStrictEqual(getSafeCodeDiagnostics(dependencyUri), []);
    assert.deepStrictEqual(getSafeCodeDiagnostics(generatedUri), []);
    assert.deepStrictEqual(getSafeCodeDiagnostics(unsupportedUri), []);
    await eventually(() => getSafeCodeDiagnostics(supportedUri), (items) => items.length === 1);
  });

  test("workspace scan respects local warning ignores", async () => {
    const uri = await createWorkspaceFile("ignored-warning.ts", 'const apiKey = "ignored-workspace-secret";');
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document);
    await vscode.commands.executeCommand("safeCode.scanOpenFiles");
    const diagnostics = await eventually(() => getSafeCodeDiagnostics(uri), (items) => items.length === 1);

    await vscode.commands.executeCommand(
      "safeCode.ignoreWarning",
      uri,
      diagnostics[0].range.start.line,
      diagnostics[0].code
    );
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    await vscode.commands.executeCommand("safeCode.scanWorkspace");

    assert.deepStrictEqual(getSafeCodeDiagnostics(uri), []);
  });

  test("reloads project ignores when configuration is created and deleted", async () => {
    const lineText = 'const apiKey = "shared-project-secret";';
    const uri = await createWorkspaceFile("shared-ignore.ts", lineText);
    await eventually(() => getSafeCodeDiagnostics(uri), (items) => items.length === 1);

    await writeProjectConfig([
      {
        filePath: getWorkspaceRelativePath(uri),
        lineHash: hashLineText(lineText),
        ruleId: "generic-secret-assignment"
      }
    ]);
    await eventually(() => getSafeCodeDiagnostics(uri), (items) => items.length === 0);

    await deleteIfExists(projectConfigUri);
    await eventually(() => getSafeCodeDiagnostics(uri), (items) => items.length === 1);
  });

  test("offers a project quick fix and keeps local and project ignores independent", async () => {
    const projectLine = 'const apiKey = "project-quick-fix-secret";';
    const projectUri = await createWorkspaceFile("project-quick-fix.ts", projectLine);
    const projectDiagnostics = await eventually(
      () => getSafeCodeDiagnostics(projectUri),
      (items) => items.length === 1
    );

    const actions = await requestCodeActions(projectUri, projectDiagnostics[0].range);
    const projectAction = actions.find((candidate): candidate is vscode.CodeAction => {
      return candidate instanceof vscode.CodeAction && candidate.title === "Safe Code: Ignore this warning for this project";
    });
    assert.ok(projectAction?.command, "The Safe Code project ignore quick fix was not returned");
    assert.strictEqual(projectAction.command.command, "safeCode.ignoreWarningForProject");
    assert.notStrictEqual(projectAction.isPreferred, true);

    await vscode.commands.executeCommand(projectAction.command.command, ...(projectAction.command.arguments ?? []));
    await eventually(() => getSafeCodeDiagnostics(projectUri), (items) => items.length === 0);

    const projectConfigBeforeLocalIgnore = await vscode.workspace.fs.readFile(projectConfigUri);
    const parsedConfig = JSON.parse(Buffer.from(projectConfigBeforeLocalIgnore).toString("utf8"));
    assert.deepStrictEqual(parsedConfig, {
      version: 1,
      ignoredWarnings: [
        {
          filePath: getWorkspaceRelativePath(projectUri),
          lineHash: hashLineText(projectLine),
          ruleId: "generic-secret-assignment"
        }
      ]
    });

    const localUri = await createWorkspaceFile("local-alongside-project.ts", 'const token = "local-ignore-secret";');
    const localDiagnostics = await eventually(() => getSafeCodeDiagnostics(localUri), (items) => items.length === 1);
    await vscode.commands.executeCommand(
      "safeCode.ignoreWarning",
      localUri,
      localDiagnostics[0].range.start.line,
      localDiagnostics[0].code
    );
    await vscode.commands.executeCommand("safeCode.scanWorkspace");

    assert.deepStrictEqual(getSafeCodeDiagnostics(projectUri), []);
    assert.deepStrictEqual(getSafeCodeDiagnostics(localUri), []);
    const projectConfigAfterLocalIgnore = await vscode.workspace.fs.readFile(projectConfigUri);
    assert.deepStrictEqual(projectConfigAfterLocalIgnore, projectConfigBeforeLocalIgnore);
  });

  test("serializes simultaneous project-ignore updates without losing entries", async () => {
    const firstLine = 'const apiKey = "first-simultaneous-project-secret";';
    const secondLine = 'const token = "second-simultaneous-project-secret";';
    const firstUri = await createWorkspaceFile("simultaneous-first.ts", firstLine);
    const secondUri = await createWorkspaceFile("simultaneous-second.ts", secondLine);
    const [firstDiagnostics, secondDiagnostics] = await Promise.all([
      eventually(() => getSafeCodeDiagnostics(firstUri), (items) => items.length === 1),
      eventually(() => getSafeCodeDiagnostics(secondUri), (items) => items.length === 1)
    ]);

    await Promise.all([
      vscode.commands.executeCommand(
        "safeCode.ignoreWarningForProject",
        firstUri,
        firstDiagnostics[0].range.start.line,
        firstDiagnostics[0].code
      ),
      vscode.commands.executeCommand(
        "safeCode.ignoreWarningForProject",
        secondUri,
        secondDiagnostics[0].range.start.line,
        secondDiagnostics[0].code
      )
    ]);

    const parsedConfig = JSON.parse(await readWorkspaceText(projectConfigUri));
    assert.deepStrictEqual(parsedConfig.ignoredWarnings, [
      {
        filePath: getWorkspaceRelativePath(firstUri),
        lineHash: hashLineText(firstLine),
        ruleId: "generic-secret-assignment"
      },
      {
        filePath: getWorkspaceRelativePath(secondUri),
        lineHash: hashLineText(secondLine),
        ruleId: "generic-secret-assignment"
      }
    ]);
    await eventually(
      () => [getSafeCodeDiagnostics(firstUri), getSafeCodeDiagnostics(secondUri)],
      (diagnostics) => diagnostics.every((items) => items.length === 0)
    );
  });

  test("keeps warnings active and preserves invalid project configuration", async () => {
    const invalidConfig = Buffer.from('{"version":1,"ignoredWarnings":[{"filePath":"../outside.ts"}]}');
    await vscode.workspace.fs.writeFile(projectConfigUri, invalidConfig);
    const uri = await createWorkspaceFile("invalid-project-config.ts", 'const apiKey = "still-visible-secret";');
    const diagnostics = await eventually(() => getSafeCodeDiagnostics(uri), (items) => items.length === 1);

    await vscode.commands.executeCommand(
      "safeCode.ignoreWarningForProject",
      uri,
      diagnostics[0].range.start.line,
      diagnostics[0].code
    );

    assert.deepStrictEqual(await vscode.workspace.fs.readFile(projectConfigUri), invalidConfig);
    assert.strictEqual(getSafeCodeDiagnostics(uri).length, 1);
  });

  test("workspace rescan removes a stale diagnostic", async () => {
    const uri = await createWorkspaceFile("stale.ts", 'const apiKey = "stale-workspace-secret";');
    await vscode.commands.executeCommand("safeCode.scanWorkspace");
    await eventually(() => getSafeCodeDiagnostics(uri), (items) => items.length === 1);

    await vscode.workspace.fs.writeFile(uri, Buffer.from("export const clean = true;"));
    await vscode.commands.executeCommand("safeCode.scanWorkspace");

    await eventually(() => getSafeCodeDiagnostics(uri), (items) => items.length === 0);
  });

  test("automatically rescans a document after an edit", async () => {
    const uri = await createWorkspaceFile("edited.ts", "export const harmless = true;");
    const document = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(document);
    assert.deepStrictEqual(getSafeCodeDiagnostics(uri), []);

    await editor.edit((builder) => {
      builder.replace(new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), 'const token = "edited-secret-value";');
    });
    await document.save();

    const diagnostics = await eventually(() => getSafeCodeDiagnostics(uri), (items) => items.length === 1);
    assert.strictEqual(diagnostics[0].code, "generic-secret-assignment");
  });

  test("clears and restores diagnostics when the extension is disabled and enabled", async () => {
    const uri = await createWorkspaceFile("configuration.ts", 'const password = "configuration-secret";');
    await vscode.window.showTextDocument(uri);
    await vscode.commands.executeCommand("safeCode.scanOpenFiles");
    await eventually(() => getSafeCodeDiagnostics(uri), (items) => items.length === 1);

    const configuration = vscode.workspace.getConfiguration("safeCode");
    await configuration.update("enabled", false, vscode.ConfigurationTarget.Global);
    await eventually(() => getSafeCodeDiagnostics(uri), (items) => items.length === 0);

    await configuration.update("enabled", true, vscode.ConfigurationTarget.Global);
    const diagnostics = await eventually(() => getSafeCodeDiagnostics(uri), (items) => items.length === 1);
    assert.strictEqual(diagnostics[0].source, "Safe Code");
  });

  test("offers and executes the ignore-warning quick fix", async () => {
    const uniqueValue = `quick-fix-${Date.now()}`;
    const uri = await createWorkspaceFile("quick-fix.ts", `const apiKey = "${uniqueValue}";`);
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document);
    await vscode.commands.executeCommand("safeCode.scanOpenFiles");
    const diagnostics = await eventually(() => getSafeCodeDiagnostics(uri), (items) => items.length === 1);

    const actions = await requestCodeActions(uri, diagnostics[0].range);
    const action = actions.find((candidate): candidate is vscode.CodeAction => {
      return candidate instanceof vscode.CodeAction && candidate.title === "Safe Code: Ignore this warning";
    });
    assert.ok(action?.command, "The Safe Code ignore quick fix was not returned");
    assert.strictEqual(action.command.command, "safeCode.ignoreWarning");
    assert.ok(action.command.arguments, "The ignore quick fix did not include command arguments");
    assert.strictEqual(action.command.arguments.length, 3);
    assert.ok(action.command.arguments[0] instanceof vscode.Uri);
    assert.strictEqual(action.command.arguments[1], diagnostics[0].range.start.line);
    assert.strictEqual(action.command.arguments[2], "generic-secret-assignment");

    try {
      await vscode.commands.executeCommand(action.command.command, ...(action.command.arguments ?? []));
    } catch (error) {
      throw new Error(`Failed to execute ignore command: ${String(error)}`);
    }
    await eventually(() => getSafeCodeDiagnostics(uri), (items) => items.length === 0);
  });

  test("moves a simple TypeScript secret to ignored environment files", async () => {
    const secretValue = `move-secret-${Date.now()}`;
    const uri = await createWorkspaceFile("environment-fix.ts", `export const clientSecret = "${secretValue}";`);
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document);
    await vscode.commands.executeCommand("safeCode.scanOpenFiles");
    const diagnostics = await eventually(() => getSafeCodeDiagnostics(uri), (items) => items.length === 1);

    const actions = await requestCodeActions(uri, diagnostics[0].range);
    const environmentAction = actions.find((candidate): candidate is vscode.CodeAction => {
      return candidate instanceof vscode.CodeAction && candidate.title === "Safe Code: Move value to .env";
    });
    assert.ok(environmentAction?.command, "The environment quick fix was not returned");
    assert.ok(
      actions.some(
        (candidate) => candidate instanceof vscode.CodeAction && candidate.title === "Safe Code: Ignore this warning"
      ),
      "The local ignore quick fix was removed"
    );
    assert.ok(
      actions.some(
        (candidate) =>
          candidate instanceof vscode.CodeAction &&
          candidate.title === "Safe Code: Ignore this warning for this project"
      ),
      "The project ignore quick fix was removed"
    );

    await vscode.commands.executeCommand(
      environmentAction.command.command,
      ...(environmentAction.command.arguments ?? [])
    );

    assert.strictEqual(document.getText(), "export const clientSecret = process.env.CLIENT_SECRET;");
    assert.strictEqual(await readWorkspaceText(environmentUri), `CLIENT_SECRET=${JSON.stringify(secretValue)}\n`);
    assert.strictEqual(await readWorkspaceText(environmentExampleUri), "CLIENT_SECRET=\n");
    assert.strictEqual(await readWorkspaceText(gitIgnoreUri), ".env\n");
    assert.ok(!(await readWorkspaceText(environmentExampleUri)).includes(secretValue));
  });

  test("does not offer the environment fix for ambiguous or unsupported assignments", async () => {
    const ambiguousUri = await createWorkspaceFile(
      "ambiguous-fix.ts",
      'const config = { apiKey: "ambiguous-secret-value" };'
    );
    const unsupportedUri = await createWorkspaceFile(
      "unsupported-fix.json",
      '{"apiKey": "unsupported-secret-value"}'
    );
    await vscode.commands.executeCommand("safeCode.scanWorkspace");

    for (const uri of [ambiguousUri, unsupportedUri]) {
      const diagnostics = await eventually(() => getSafeCodeDiagnostics(uri), (items) => items.length === 1);
      const actions = await requestCodeActions(uri, diagnostics[0].range);
      assert.ok(
        !actions.some(
          (candidate) => candidate instanceof vscode.CodeAction && candidate.title === "Safe Code: Move value to .env"
        ),
        uri.fsPath
      );
    }
  });

  test("does not diagnose clean, unsupported, or out-of-workspace files", async () => {
    const cleanUri = await createWorkspaceFile("clean.ts", 'const apiKey = "your-api-key-here";');
    const unsupportedUri = await createWorkspaceFile("unsupported.txt", 'const apiKey = "real-looking-secret";');
    const outsidePath = path.join(os.tmpdir(), `safe-code-${Date.now()}.ts`);
    const outsideUri = vscode.Uri.file(outsidePath);

    try {
      await fs.writeFile(outsidePath, 'const apiKey = "outside-workspace-secret";', "utf8");
      await vscode.workspace.openTextDocument(cleanUri);
      await vscode.workspace.openTextDocument(unsupportedUri);
      await vscode.workspace.openTextDocument(outsideUri);
      await vscode.commands.executeCommand("safeCode.scanOpenFiles");

      assert.deepStrictEqual(getSafeCodeDiagnostics(cleanUri), []);
      assert.deepStrictEqual(getSafeCodeDiagnostics(unsupportedUri), []);
      assert.deepStrictEqual(getSafeCodeDiagnostics(outsideUri), []);
    } finally {
      await fs.rm(outsidePath, { force: true });
    }
  });

  async function createWorkspaceFile(
    fileName: string,
    content: string,
    options: { waitForCreateEvent?: boolean } = {}
  ): Promise<vscode.Uri> {
    const relativeDirectory = path.posix.dirname(fileName);
    const uniqueFileName = `${Date.now()}-${path.posix.basename(fileName)}`;
    const uri =
      relativeDirectory === "."
        ? vscode.Uri.joinPath(runtimeDirectory, uniqueFileName)
        : vscode.Uri.joinPath(runtimeDirectory, relativeDirectory, uniqueFileName);
    const parentUri = vscode.Uri.file(path.dirname(uri.fsPath));
    await vscode.workspace.fs.createDirectory(parentUri);
    if (options.waitForCreateEvent !== false) {
      await writeWorkspaceFileAndWaitForCreate(uri, content);
    } else {
      await vscode.workspace.fs.writeFile(uri, Buffer.from(content));
    }
    createdWorkspaceFiles.push(uri);
    return uri;
  }

  async function createWorkspaceFileWithExactBaseName(fileName: string, content: string): Promise<vscode.Uri> {
    const uniqueDirectory = vscode.Uri.joinPath(runtimeDirectory, `exact-${Date.now()}-${createdWorkspaceFiles.length}`);
    await vscode.workspace.fs.createDirectory(uniqueDirectory);
    const uri = vscode.Uri.joinPath(uniqueDirectory, fileName);
    await writeWorkspaceFileAndWaitForCreate(uri, content);
    createdWorkspaceFiles.push(uri);
    return uri;
  }

  async function writeWorkspaceFileAndWaitForCreate(uri: vscode.Uri, content: string): Promise<void> {
    const relativePath = getWorkspaceRelativePath(uri);
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(workspaceRoot, relativePath)
    );
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const observed = new Promise<void>((resolve, reject) => {
      watcher.onDidCreate((createdUri) => {
        if (createdUri.toString() === uri.toString()) {
          resolve();
        }
      });
      timeout = setTimeout(() => reject(new Error(`File creation was not observed for ${relativePath}`)), 5_000);
    });

    try {
      await vscode.workspace.fs.writeFile(uri, Buffer.from(content));
      await observed;
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
      watcher.dispose();
    }
  }

  async function writeProjectConfig(ignoredWarnings: Array<Record<string, string>>): Promise<void> {
    await vscode.workspace.fs.writeFile(
      projectConfigUri,
      Buffer.from(`${JSON.stringify({ version: 1, ignoredWarnings }, null, 2)}\n`)
    );
  }

  function getWorkspaceRelativePath(uri: vscode.Uri): string {
    return path.relative(workspaceRoot.fsPath, uri.fsPath).split(path.sep).join("/");
  }
});

function getSafeCodeDiagnostics(uri: vscode.Uri): vscode.Diagnostic[] {
  return vscode.languages.getDiagnostics(uri).filter((diagnostic) => diagnostic.source === "Safe Code");
}

function isDocumentOpen(uri: vscode.Uri): boolean {
  return vscode.workspace.textDocuments.some((document) => document.uri.toString() === uri.toString());
}

async function deleteIfExists(uri: vscode.Uri): Promise<void> {
  try {
    await vscode.workspace.fs.delete(uri, { useTrash: false });
  } catch (error) {
    if (!(error instanceof vscode.FileSystemError) || error.code !== "FileNotFound") {
      throw error;
    }
  }
}

async function readWorkspaceText(uri: vscode.Uri): Promise<string> {
  return Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf8");
}

async function requestCodeActions(
  uri: vscode.Uri,
  range: vscode.Range
): Promise<(vscode.CodeAction | vscode.Command)[]> {
  let lastError: unknown;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      return await vscode.commands.executeCommand<(vscode.CodeAction | vscode.Command)[]>(
        "vscode.executeCodeActionProvider",
        uri,
        range,
        vscode.CodeActionKind.QuickFix.value
      );
    } catch (error) {
      lastError = error;
      if (!String(error).includes("Canceled")) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  throw new Error(`Failed to request code actions: ${String(lastError)}`);
}

async function eventually<T>(read: () => T, predicate: (value: T) => boolean, timeout = 5_000): Promise<T> {
  const deadline = Date.now() + timeout;
  let value = read();

  while (!predicate(value) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    value = read();
  }

  assert.ok(predicate(value), `Condition was not met within ${timeout}ms`);
  return value;
}
