# Safe Code

Catch secrets before Git does.

Safe Code is a lightweight VS Code extension that detects possible hardcoded secrets directly in your editor. It warns about API keys, tokens, passwords, private keys, and database URLs before they accidentally get committed.

## MVP features

- Automatically scans supported files across the workspace when Safe Code starts and keeps them updated as files change.
- Adds VS Code diagnostics so matches appear as yellow warning underlines and in the Problems tab.
- Moves supported JavaScript and TypeScript secret assignments to local environment configuration with a quick fix.
- Provides local and shared-project quick fixes for known false positives.
- Stores personal ignores locally in VS Code workspace storage and team ignores in `.safe-code.json`.
- Skips noisy dependency/build folders such as `node_modules`, `.git`, `dist`, `build`, and `coverage`.

## Supported files

Safe Code scans common code and config files: `.ts`, `.tsx`, `.js`, `.jsx`, `.py`, `.go`, `.java`, `.cs`, `.php`, `.rb`, `.env`, `.json`, `.yaml`, `.yml`, `.toml`, `.ini`, and `.md`. Files named `.env`, `.env.local`, and other `.env.*` variants remain eligible, but directories named exactly `.env` are always excluded at any depth.

## Current detections

- Generic secret assignments such as `apiKey = "..."`, `password: "..."`, `client_secret = "..."`, and `DATABASE_URL=...`.
- Private key headers such as `-----BEGIN PRIVATE KEY-----`.
- Database URLs with embedded credentials.
- GitHub tokens, AWS access keys, and Stripe live secret keys.

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

Use `Safe Code: Ignore this warning` to keep an ignore local to your VS Code workspace storage. This remains the preferred quick fix and does not change project files.

Use `Safe Code: Ignore this warning for this project` when the false positive should be shared with the team. This explicit action creates or updates `.safe-code.json` at the root of the file's workspace folder:

```json
{
  "version": 1,
  "ignoredWarnings": [
    {
      "filePath": "src/config.ts",
      "lineHash": "0123456789abcdef01234567",
      "ruleId": "generic-secret-assignment"
    }
  ]
}
```

Each entry matches the workspace-relative file path, the first 24 hexadecimal characters of the SHA-256 hash of the trimmed source line, and the detection rule ID. Changing the source line makes the old ignore stop matching. In a multi-root workspace, each folder has its own `.safe-code.json`.

Safe Code reloads this file when it is created, changed, or deleted. Invalid configuration is reported in the **Safe Code** output channel and suppresses no warnings. The project quick fix will not overwrite an invalid file.

## Release integrity

The release workflow builds and tests the extension once with pinned Node.js, VSCE, runner, and GitHub Action versions. It records the source commit, tool versions, artifact size, and SHA-256 digest in `release-manifest.json`, then passes the same prebuilt VSIX to the Visual Studio Marketplace publisher and the GitHub release publisher. The GitHub Release contains the versioned VSIX, its `.sha256` file, and the manifest.

Pull requests and `publish: false` manual runs exercise the complete build, test, and packaging path without publishing or receiving publication credentials. Production publication is restricted to a manual run from `main` with an exact expected version and Marketplace OIDC trust. The Marketplace signs and repackages extensions, so its public download bytes can differ from the uploaded VSIX; the GitHub asset and recorded digest preserve the original build artifact for independent verification.
For safety, `.safe-code.json` must be either missing or a regular file. Safe Code refuses symbolic links, directories, and other filesystem entry types, and it never follows a link to read or update project ignores. A missing configuration is created exclusively; an existing valid configuration is revalidated against the exact bytes and file identity that were read before it is replaced atomically. If the path or contents change during the operation, the update stops and the in-memory project ignores fail closed.

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
    "**/dist/**",
    "**/build/**",
    "**/coverage/**",
    "**/vendor/**",
    "**/target/**",
    "**/.cache/**"
  ]
}
```

The built-in dependency, build, cache, and exact `.env/` directory exclusions are always enforced. Add workspace-relative glob patterns to `safeCode.ignoredPaths` for project-specific generated files or directories.

`safeCode.maxFileSizeBytes` limits each file to 1 MiB by default. Closed files are checked before they are opened, while open or unsaved documents are measured from their current UTF-8 text. Files exactly at the limit are accepted; larger files are skipped and any old Safe Code diagnostic for them is removed.

Full workspace scans consider at most `safeCode.maxWorkspaceScanFiles` supported files and `safeCode.maxWorkspaceScanBytes` of text (10,000 files and 100 MiB by default). When either workspace budget is reached, Safe Code reports a partial scan, keeps results for processed files, and leaves diagnostics for unvisited files unchanged. Oversized files, partial scans, and read failures are reported as aggregate counts instead of one notification per file.

Set `safeCode.scanWorkspaceOnStartup` to `false` if you prefer to run full workspace scans manually. Supported files that are created or changed while VS Code is open are still scanned automatically, and their Problems entries remain visible after their editor tabs close.
