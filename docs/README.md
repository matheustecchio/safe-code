# Safe Code Documentation

This folder contains project documentation for Safe Code.

## Developer Documentation

All developer-facing documentation lives under [`docs/dev/`](./dev/).

- [Development guide](./dev/development.md)
- [Detection rules](./dev/rules.md)

Release instructions for maintainers are documented in the [Release Workflow](./dev/development.md#release-workflow).

## Current MVP Scope

Safe Code scans supported files across the current VS Code workspace. It creates warning diagnostics for suspicious hardcoded secrets and supports local or shared project-level ignores.

The command `Safe Code: Scan Open Files` rescans open workspace files. `Safe Code: Scan Workspace` scans supported open and unopened files across every workspace folder.
