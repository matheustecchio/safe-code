# How Safe Code Works

Safe Code is a VS Code extension that scans open workspace files for suspicious hardcoded secrets. When it finds one, it creates a VS Code diagnostic so the editor shows a yellow underline and the Problems tab shows a warning.

## Runtime Flow

1. VS Code activates the extension through `src/extension.ts`.
2. The extension creates a diagnostic collection named `safe-code`.
3. The extension creates an `IgnoreStore` backed by VS Code `workspaceState`.
4. The extension registers document, configuration, command, and quick-fix handlers.
5. When a supported file opens or changes, Safe Code queues a scan with a short debounce.
6. The scanner checks whether the document should be scanned.
7. The scanner applies each rule from `src/rules.ts` to the document text.
8. Findings that are not ignored are converted into VS Code diagnostics.
9. Diagnostics are stored in the diagnostic collection and shown by VS Code.

## Main Files

| File | Responsibility |
| --- | --- |
| `package.json` | VS Code extension manifest, commands, activation events, settings, scripts, and dependencies. |
| `src/extension.ts` | Extension entry point. Wires events, diagnostics, commands, settings, and quick fixes. |
| `src/scanner.ts` | Decides which documents can be scanned and turns regex matches into `SecretFinding` objects. |
| `src/rules.ts` | Defines the secret detection rules and their messages. |
| `src/ignoreStore.ts` | Stores and checks locally ignored warnings. |

## Activation

The extension activates from these events in `package.json`:

- `onStartupFinished` activates Safe Code after VS Code finishes startup.
- `onCommand:safeCode.scanOpenFiles` activates Safe Code if the scan command is run before startup activation.

The activation function is `activate(context)` in `src/extension.ts`.

## Event Handlers

`src/extension.ts` registers these handlers:

- `onDidOpenTextDocument` queues a scan when a file opens.
- `onDidChangeTextDocument` queues a scan when a file changes.
- `onDidCloseTextDocument` removes diagnostics for the closed file.
- `onDidChangeActiveTextEditor` queues a scan when the active editor changes.
- `onDidChangeConfiguration` rescans open files when `safeCode` settings change.
- `registerCodeActionsProvider` provides the `Safe Code: Ignore this warning` quick fix.
- `safeCode.ignoreWarning` stores a local ignore entry and rescans the document.
- `safeCode.scanOpenFiles` rescans open workspace files.

## Debounced Scanning

`queueScan(document)` waits 250ms before running `scanNow(document)`. If the same document changes again before the timer fires, the old timer is cancelled.

This avoids rescanning on every keystroke while the user is typing quickly.

## Document Filtering

The scanner only scans documents that pass `shouldScanDocument(document, options)` in `src/scanner.ts`.

A document is skipped when:

- The URI scheme is not `file`.
- The file is not inside a VS Code workspace folder.
- The file extension is not supported.
- The workspace-relative path matches `safeCode.ignoredPaths`.

Supported file types are code and config files such as `.ts`, `.tsx`, `.js`, `.jsx`, `.py`, `.go`, `.java`, `.cs`, `.php`, `.rb`, `.env`, `.json`, `.yaml`, `.yml`, `.toml`, `.ini`, and `.md`.

Default ignored paths include `node_modules`, `.git`, `dist`, `build`, `coverage`, `vendor`, `target`, and `.cache`.

## Scanning

`scanDocument(document, options)` reads the full document text with `document.getText()` and applies every rule from `secretRules`.

For each regex match, the scanner:

1. Extracts the matched value.
2. Trims the value.
3. Rejects short generic values using `safeCode.minimumSecretLength`.
4. Rejects common fake placeholder values.
5. Calculates the VS Code `Range` for the suspicious value.
6. Stores the line text used for ignore matching.
7. Returns a `SecretFinding` with rule, severity, message, value, range, and line text.

The scanner deduplicates findings by range. If two rules match the same range, the finding with the higher internal severity wins.

## Diagnostics

`scanNow(document)` converts each `SecretFinding` into a `vscode.Diagnostic`.

Each diagnostic uses:

- `vscode.DiagnosticSeverity.Warning` for the MVP.
- `source = "Safe Code"` so quick fixes can identify Safe Code diagnostics.
- `code = finding.ruleId` so ignores know which rule created the warning.
- `range = finding.range` so VS Code underlines the suspicious value.
- `message = finding.message` so the Problems tab shows the warning text.

The diagnostics are stored with `diagnostics.set(document.uri, documentDiagnostics)`.

## Ignore Quick Fix

The quick fix is implemented by `SafeCodeActionProvider` in `src/extension.ts`.

When VS Code asks for code actions, the provider:

1. Filters diagnostics to only those with `source === "Safe Code"`.
2. Creates a `CodeAction` titled `Safe Code: Ignore this warning`.
3. Calls the internal command `safeCode.ignoreWarning` with the file URI, diagnostic line, and rule ID.

The command opens the document, reads the current line text, stores the ignore entry, and rescans the document. The warning disappears if the stored ignore matches the new scan result.

## Ignore Storage

Ignore storage lives in `src/ignoreStore.ts`.

An ignored warning has this shape:

```ts
export type IgnoredWarning = {
  filePath: string;
  lineHash: string;
  ruleId: string;
};
```

The ignore key is based on:

- Workspace folder name plus relative file path.
- A SHA-256 hash of the trimmed line text, shortened to 24 hex characters.
- The rule ID that created the warning.

Ignored warnings are stored in `context.workspaceState` under `safeCode.ignoredWarnings`. This means ignores are local to the user's VS Code workspace storage and are not committed to the project.

## Settings

Settings are declared in `package.json` and read by `getScannerOptions()` in `src/extension.ts`.

Current settings are:

- `safeCode.enabled` enables or disables diagnostics.
- `safeCode.minimumSecretLength` controls the minimum value length for generic secret assignment rules.
- `safeCode.ignoredPaths` controls workspace-relative glob patterns that Safe Code skips.

## MVP Limitations

- All diagnostics use Warning severity, even though rules already store `low`, `medium`, and `high` internally.
- The scan command currently scans open workspace files, not the whole workspace.
- Ignores are local only and are not shared with a team.
- Changing the line text changes the line hash, so the old ignore no longer applies.
- Detection is regex-based and intentionally avoids entropy detection for now.
