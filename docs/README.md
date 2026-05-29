# Safe Code Documentation

This folder explains how the Safe Code extension works internally.

## Core docs

- [How Safe Code Works](./how-it-works.md) explains the runtime flow from VS Code activation to diagnostics and quick fixes.
- [Detection Rules](./detection-rules.md) explains how secret patterns are defined, filtered, and converted into findings.
- [Development Guide](./development.md) explains the project structure, commands, and common extension points.

## Current MVP scope

Safe Code currently scans supported files that are open in the current VS Code workspace. It creates warning diagnostics for suspicious hardcoded secrets and lets the user ignore a specific warning locally.

The command `Safe Code: Scan Open Files` rescans open workspace files. It does not scan every file in the workspace yet.
