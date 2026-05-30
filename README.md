# Safe Code

Catch secrets before Git does.

Safe Code is a lightweight VS Code extension that detects possible hardcoded secrets directly in your editor. It warns about API keys, tokens, passwords, private keys, and database URLs before they accidentally get committed.

## MVP features

- Scans supported files in the current workspace when they are opened or changed.
- Adds VS Code diagnostics so matches appear as yellow warning underlines and in the Problems tab.
- Provides a quick fix: `Safe Code: Ignore this warning`.
- Stores ignored warnings locally in VS Code workspace storage using `file path + line hash + rule id`.
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

## Documentation

- [Documentation index](./docs/README.md)
- [Developer documentation](./docs/dev/README.md)
- [Development guide](./docs/dev/development.md)
- [Detection rules](./docs/dev/rules.md)

## Settings

```json
{
  "safeCode.enabled": true,
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
