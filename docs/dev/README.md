# Developer Documentation

This folder contains the developer-facing documentation for Safe Code.

## Core Docs

- [Development Guide](./development.md) covers the local workflow, project structure, extension runtime flow, diagnostics, quick fixes, ignore storage, settings, and manual testing.
- [Detection Rules](./rules.md) covers how secret detection rules are shaped, filtered, and extended.

## Documentation Expectations

When code behavior changes, update these docs in the same branch when the change affects developer understanding.

Update `development.md` when extension architecture, commands, settings, activation flow, diagnostics, quick fixes, scanning behavior, or ignore behavior changes.

Update `rules.md` when detection rules, placeholder filtering, rule design guidance, or scanner rule handling changes.
