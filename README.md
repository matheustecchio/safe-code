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

Safe Code scans common code and config files: `.ts`, `.tsx`, `.js`, `.jsx`, `.py`, `.go`, `.java`, `.cs`, `.php`, `.rb`, `.env`, `.json`, `.yaml`, `.yml`, `.toml`, `.ini`, and `.md`.

## Current detections

- Generic secret assignments such as `apiKey = "..."`, `password: "..."`, `client_secret = "..."`, and `DATABASE_URL=...`.
- Private key headers such as `-----BEGIN PRIVATE KEY-----`.
- Database URLs with embedded credentials.
- GitHub tokens, AWS access keys, and Stripe live secret keys.

Safe Code ignores common placeholder values such as `example`, `sample`, `test`, `fake`, `dummy`, `changeme`, `your-api-key`, `your-token`, `xxx`, `123456`, and `password`.

## Commands

- `Safe Code: Scan Open Files` rescans currently open workspace files.
- `Safe Code: Scan Workspace` scans every supported file in the current workspace and reports findings from both open and unopened files in the Problems tab. The scan shows cancellable progress and keeps results that were processed before cancellation.

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

Safe Code infers an uppercase snake-case name, writes the real value to `.env` at the workspace-folder root, and creates or updates `.env.example` with an empty `CLIENT_SECRET=` entry. Before writing the value, it adds an exact `.env` entry to the root `.gitignore`.

The fix refuses to modify a tracked `.env`, symbolic links, an existing environment variable with a different value, or ambiguous code such as object properties, destructuring, function calls, concatenations, and template literals. The secret value is never copied into `.env.example`. Existing ignore-warning quick fixes remain available.

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
  "safeCode.ignoredPaths": [
    "**/node_modules/**",
    "**/.git/**",
    "**/dist/**",
    "**/build/**",
    "**/coverage/**",
    "**/vendor/**",
    "**/target/**",
    "**/.cache/**"
  ]
}
```

The built-in dependency, build, and cache exclusions are always enforced. Add workspace-relative glob patterns to `safeCode.ignoredPaths` for project-specific generated files or directories.

Set `safeCode.scanWorkspaceOnStartup` to `false` if you prefer to run full workspace scans manually. Supported files that are created or changed while VS Code is open are still scanned automatically, and their Problems entries remain visible after their editor tabs close.
