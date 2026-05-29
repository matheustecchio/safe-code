# Agent Instructions

This repository contains Safe Code, a VS Code extension that detects suspicious hardcoded secrets in workspace files and reports them as editor diagnostics.

## Project Overview

- Extension name: `Safe Code`
- Package name: `safe-code`
- Main entry point: `src/extension.ts`
- Build output: `out/`
- Runtime target: VS Code extension API
- Language: TypeScript with `strict` enabled

## Core Files

- `package.json` defines extension metadata, commands, settings, activation events, scripts, and dev dependencies.
- `src/extension.ts` wires activation, diagnostics, event listeners, commands, and quick fixes.
- `src/scanner.ts` filters documents and turns rule matches into findings.
- `src/rules.ts` defines secret detection regex rules.
- `src/ignoreStore.ts` stores ignored warnings in VS Code `workspaceState`.
- `docs/` contains architecture, detection, and development documentation.

## Commands

- Install dependencies: `npm install`
- Compile: `npm run compile`
- Watch TypeScript: `npm run watch`
- Local VS Code test from the repository root: `code --extensionDevelopmentPath="$(pwd)"`

Run `npm run compile` before committing TypeScript changes.

## Development Guidelines

- Keep changes small and focused.
- Prefer simple TypeScript over unnecessary abstractions.
- Keep scanner rules conservative to avoid noisy false positives.
- Do not add entropy detection until ignore and severity UX are stronger.
- Do not scan outside the current VS Code workspace.
- Respect ignored paths such as `node_modules`, `.git`, `dist`, `build`, and `coverage`.
- Preserve the current MVP behavior unless the task explicitly asks to change it.
- For documentation-only changes, a compile step is optional unless code or config changed.

## Commit And Branch Workflow

- Do not commit directly to `main`.
- Create a new branch before making commits.
- Use descriptive branch names such as `feature/workspace-scan`, `fix/ignore-warning`, or `docs/update-agent-instructions`.
- Stage files deliberately so each commit contains one logical change.
- Prefer multiple meaningful commits over one large mixed commit.
- Good commit split examples: scaffold, implementation, tests, documentation.
- Write concise commit messages in imperative mood.
- Push the feature branch when the work is complete.
- Do not merge the branch into `main`.
- Do not create a merge commit unless explicitly requested.
- The repository owner will open and manage PRs.

## Safety Rules

- Never commit real secrets, tokens, private keys, database URLs, or credentials.
- Do not remove or rewrite user changes unless explicitly requested.
- Do not amend commits unless explicitly requested.
- Do not force-push unless explicitly requested.
- Do not run destructive git commands such as `git reset --hard` or `git checkout --` unless explicitly approved.

## Manual Test Cases

These examples should produce warnings in supported workspace files:

```ts
const apiKey = "sk_live_123456789abcdef";
const clientSecret = "super-secret-value";
```

```dotenv
DATABASE_URL=postgres://user:pass@example.com/app
```

```text
-----BEGIN PRIVATE KEY-----
```

This placeholder should not warn:

```ts
const exampleApiKey = "your-api-key-here";
```
