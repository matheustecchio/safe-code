import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";

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
  let createdWorkspaceFiles: vscode.Uri[] = [];

  suiteSetup(async () => {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(workspaceFolder, "The integration fixture workspace must be open");
    workspaceRoot = workspaceFolder.uri;
    runtimeDirectory = vscode.Uri.joinPath(workspaceRoot, runtimeDirectoryName);
    await vscode.workspace.fs.createDirectory(runtimeDirectory);

    const extension = vscode.extensions.getExtension(extensionId);
    assert.ok(extension, `Extension ${extensionId} was not found`);
    await extension.activate();
  });

  setup(async () => {
    const configuration = vscode.workspace.getConfiguration("safeCode");
    await configuration.update("enabled", true, vscode.ConfigurationTarget.Global);
    await configuration.update("minimumSecretLength", 8, vscode.ConfigurationTarget.Global);
    await configuration.update("ignoredPaths", defaultIgnoredPaths, vscode.ConfigurationTarget.Global);
  });

  teardown(async () => {
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    for (const uri of createdWorkspaceFiles) {
      await vscode.workspace.fs.delete(uri, { useTrash: false });
    }
    createdWorkspaceFiles = [];
  });

  suiteTeardown(async () => {
    const configuration = vscode.workspace.getConfiguration("safeCode");
    await configuration.update("enabled", undefined, vscode.ConfigurationTarget.Global);
    await configuration.update("minimumSecretLength", undefined, vscode.ConfigurationTarget.Global);
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

  async function createWorkspaceFile(fileName: string, content: string): Promise<vscode.Uri> {
    const uri = vscode.Uri.joinPath(runtimeDirectory, `${Date.now()}-${fileName}`);
    await vscode.workspace.fs.writeFile(uri, Buffer.from(content));
    createdWorkspaceFiles.push(uri);
    return uri;
  }
});

function getSafeCodeDiagnostics(uri: vscode.Uri): vscode.Diagnostic[] {
  return vscode.languages.getDiagnostics(uri).filter((diagnostic) => diagnostic.source === "Safe Code");
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
