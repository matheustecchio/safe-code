# Safe Code

Catch secrets before Git does.

Safe Code is a lightweight VS Code extension that detects possible hardcoded secrets directly in your editor. It warns about API keys, tokens, passwords, private keys, and database URLs before they accidentally get committed.

## MVP features

- Automatically scans supported files across the workspace when Safe Code starts and keeps them updated as files change.
- Adds VS Code diagnostics so matches appear as yellow warning underlines and in the Problems tab.
- Moves supported JavaScript and TypeScript secret assignments to local environment configuration with a quick fix.
- Provides local and shared-project quick fixes for known false positives.
- Stores personal ignores locally in VS Code workspace storage and team ignores in `.vscode/.safe-code.json`.
- Skips noisy dependency/build folders such as `node_modules`, `.git`, `dist`, `build`, and `coverage`.

## Supported files

Safe Code scans common code and config files: `.ts`, `.tsx`, `.js`, `.jsx`, `.py`, `.go`, `.java`, `.cs`, `.php`, `.rb`, `.env`, `.json`, `.yaml`, `.yml`, `.toml`, `.ini`, and `.md`. Files named `.env`, `.env.local`, and other `.env.*` variants remain eligible, but directories named exactly `.env`, `.venv`, `venv`, or `.environment` are always excluded at any depth.

## Current detections

- Quoted secret assignments such as `apiKey = "..."`, `password: "..."`, and `client_secret = "..."`.
- Unquoted secret assignments such as `API_KEY=value`, including `export` assignments, only in files named `.env` or `.env.*` (case-insensitive).
- Private key headers such as `-----BEGIN PRIVATE KEY-----`.
- Database URLs with embedded credentials.
- GitHub tokens, AWS access keys, and Stripe live secret keys.

Source identifiers, member accesses, and environment lookups are not treated as unquoted dotenv credentials. Interpolated backtick templates do not trigger the generic assignment rule; plain quoted and non-interpolated backtick literals remain eligible. Specialized credential signatures remain detectable inside expressions. This is conservative regex matching, not language parsing or data-flow analysis; it does not add unquoted YAML/INI or shell-expansion support.

Safe Code ignores common placeholder values such as `example`, `sample`, `test`, `fake`, `dummy`, `changeme`, `your-api-key`, `your-token`, `xxx`, `123456`, and `password`.

## Commands

- `Safe Code: Scan Open Files` rescans currently open workspace files.
- `Safe Code: Scan Workspace` scans supported files in the current workspace within the configured file and byte budgets, then reports findings from both open and unopened files in the Problems tab. The scan shows cancellable progress and keeps results that were processed before cancellation or a partial scan.

`Safe Code: Scan Workspace` is also available by right-clicking an editor tab or a file in the Explorer.

## Moving secrets to environment variables

For a generic warning on a simple JavaScript or TypeScript assignment, use `Safe Code: Move value to .env`. For example:

```ts
const clientSecret = "real-secret-value";
```

becomes:

```ts
const clientSecret = process.env.CLIENT_SECRET;
```

Safe Code infers an uppercase snake-case name, writes the real value to `.env` at the workspace-folder root, and creates or updates `.env.example` with an empty `CLIENT_SECRET=` entry. Before writing the value, it places a protected temporary-file rule followed by an exact `/.env` rule at the end of the root `.gitignore`, then verifies both rules with Git.

The cancellable fix is serialized per workspace and refuses tracked `.env` files, symbolic links, non-regular or invalid UTF-8 targets, concurrent changes, conflicting values, stale source ranges, and ambiguous code such as object properties, destructuring, function calls, concatenations, and template literals. It snapshots the three target files before changing anything and conditionally rolls back completed file and source edits if a later step fails. The secret value is never copied into `.env.example` or included in an error message. Existing ignore-warning quick fixes remain available.

## Ignoring warnings

Use `Safe Code: Ignore this warning` to ignore only the matching occurrence in your local VS Code workspace storage. This remains the preferred quick fix and does not change project files.

Use `Safe Code: Ignore this warning type for this project` to suppress every finding from that exact detection rule throughout the file's workspace folder, for everyone sharing its configuration. This also hides future genuine findings from that rule, regardless of file, variable name, line, or value. Other rules remain active. The action creates or updates `.vscode/.safe-code.json` (creating `.vscode` when needed):

```json
{
  "version": 2,
  "ignoredWarnings": [],
  "ignoredRules": ["generic-secret-assignment"]
}
```

`ignoredRules` uses exact stable rule IDs, with no wildcard matching. Each folder in a multi-root workspace has independent configuration; ignoring a rule in one folder does not suppress it in another. Already reported findings are refreshed automatically, even with startup scanning disabled.

Version 1 configurations remain supported without being rewritten on read. Their `ignoredWarnings` entries keep matching only the workspace-relative file path, trimmed source-line hash, and rule ID. The project action upgrades a valid version 1 file to version 2, retains its occurrence entries and any existing ignored rules, and adds only the selected rule. Local ignores and legacy occurrence ignores stop matching when the source line changes. No source text or secret values are stored.

Older extension versions reject version 2 and keep warnings active. Teammates need the updated extension to use these shared rule ignores. Remove an ID from `ignoredRules` to restore that rule's findings, except occurrences still covered by local or legacy ignores.

Safe Code reloads this file when it is created, changed, or deleted. Invalid configuration is reported in the **Safe Code** output channel and suppresses no warnings. The project quick fix will not overwrite an invalid file.

Existing root-level `.safe-code.json` files are no longer loaded or updated. Move the file manually to `.vscode/.safe-code.json` to keep its shared ignores; entry paths remain relative to the workspace root.

For safety, `.vscode/.safe-code.json` must be either missing or a regular file, and its `.vscode` parent must be a real directory rather than a symbolic link. Safe Code checks for and rejects existing symbolic links and other unsupported filesystem entry types. A missing configuration is created exclusively; an existing valid configuration is revalidated against the exact bytes and file identity that were read before it is replaced atomically. If a concurrent change is detected, the operation reports an error and the in-memory project ignores fail closed; a write may already have occurred. These checks do not protect against a malicious local process changing filesystem paths during an operation.

## Release integrity

The release workflow builds and tests the extension once with pinned Node.js, VSCE, runner, and GitHub Action versions. It records the source commit, tool versions, artifact size, and SHA-256 digest in `release-manifest.json`, then publishes a GitHub Release containing the versioned VSIX, its `.sha256` file, and the manifest. The extension owner downloads that Release VSIX and uploads it manually to the Visual Studio Marketplace.

Pull requests and `publish: false` manual runs exercise the complete build, test, and packaging path without publishing. GitHub Release publication requires a manual run from `main` with an exact expected version; ordinary runs do not publish to the Marketplace or need Marketplace credentials. The GitHub Release is public before the manual Marketplace upload. The Marketplace signs and repackages extensions, so its public download bytes can differ from the uploaded VSIX; the GitHub asset and recorded digest preserve the original build artifact for independent verification.

Version `1.0.0` is already published in the [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=matheus-tecchio.safe-code) and as [GitHub Release v1.0.0](https://github.com/matheustecchio/safe-code/releases/tag/v1.0.0). Do not dispatch the retained `1.0.0` incident recovery: its required absence checks are no longer true. The ordinary release path also rejects `1.0.0`; use the GitHub-first workflow above for future versions. The [development guide](./docs/dev/development.md#incident-recovery-for-the-ambiguous-100-attempt) records the historical recovery gates.

## Documentation

- [Documentation index](./docs/README.md)
- [Development guide](./docs/dev/development.md)
- [Detection rules](./docs/dev/rules.md)

## Settings

```json
{
  "safeCode.enabled": true,
  "safeCode.scanWorkspaceOnStartup": true,
  "safeCode.minimumSecretLength": 8,
  "safeCode.maxFileSizeBytes": 1048576,
  "safeCode.maxWorkspaceScanFiles": 10000,
  "safeCode.maxWorkspaceScanBytes": 104857600,
  "safeCode.ignoredPaths": [
    "**/node_modules/**",
    "**/.git/**",
    "**/.env/**",
    "**/.venv/**",
    "**/venv/**",
    "**/.environment/**",
    "**/dist/**",
    "**/build/**",
    "**/coverage/**",
    "**/vendor/**",
    "**/target/**",
    "**/.cache/**"
  ]
}
```

The built-in dependency, build, cache, and exact `.env/`, `.venv/`, `venv/`, and `.environment/` directory exclusions are always enforced. Add workspace-relative glob patterns to `safeCode.ignoredPaths` for project-specific generated files or directories. Empty or replacement arrays cannot disable built-in exclusions. Similar names such as `.venv-config`, `my.venv`, `.environment-config`, `env`, and `environment` remain eligible. General Git ignore filtering is not implemented: even Git-ignored `.env` and `.env.*` files remain eligible for secret diagnostics.

`safeCode.maxFileSizeBytes` limits each file to 1 MiB by default. Closed files are checked before they are opened, while open or unsaved documents are measured from their current UTF-8 text. Files exactly at the limit are accepted; larger files are skipped and any old Safe Code diagnostic for them is removed.

Full workspace scans consider at most `safeCode.maxWorkspaceScanFiles` supported files and `safeCode.maxWorkspaceScanBytes` of text (10,000 files and 100 MiB by default). When either workspace budget is reached, Safe Code reports a partial scan, keeps results for processed files, and leaves diagnostics for unvisited files unchanged. Oversized files, partial scans, and read failures are reported as aggregate counts instead of one notification per file.

Set `safeCode.scanWorkspaceOnStartup` to `false` if you prefer to run full workspace scans manually. Supported files that are created or changed while VS Code is open are still scanned automatically, and their Problems entries remain visible after their editor tabs close.
