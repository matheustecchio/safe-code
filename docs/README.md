# Safe Code Documentation

This folder contains project documentation for Safe Code.

## Developer Documentation

All developer-facing documentation lives under [`docs/dev/`](./dev/).

- [Development guide](./dev/development.md)
- [Detection rules](./dev/rules.md)

## Current MVP Scope

Safe Code currently scans supported files that are open in the current VS Code workspace. It creates warning diagnostics for suspicious hardcoded secrets and lets the user ignore a specific warning locally.

The command `Safe Code: Scan Open Files` rescans open workspace files. It does not scan every file in the workspace yet.
