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
- `src/environmentFixCore.ts` parses supported assignments, infers environment names, and updates environment-file text.
- `src/environmentStore.ts` protects and writes workspace-root environment files for the move-secret quick fix.
- `src/scanner.ts` filters documents and turns rule matches into findings.
- `src/rules.ts` defines secret detection regex rules.
- `src/ignoreCore.ts` defines shared ignore identities and validates project ignore configuration.
- `src/ignoreStore.ts` stores local ignored warnings in VS Code `workspaceState`.
- `src/projectIgnoreStore.ts` loads and updates shared `.safe-code.json` ignores.
- `docs/` contains the documentation index.
- `docs/dev/` contains developer-facing architecture, workflow, and detection rule documentation.

## Commands

- Install dependencies: `npm install`
- Compile: `npm run compile`
- Watch TypeScript: `npm run watch`
- Local VS Code test from the repository root: `code --extensionDevelopmentPath="$(pwd)"`
- Package extension with the pinned local tool: `./node_modules/.bin/vsce package --no-dependencies`
- Test release automation: `npm run test:release`
- Verify workflow action pins: `npm run verify:workflow-pins`
- Publish extension: use the `Publish release` GitHub Actions workflow; do not publish locally.

Run `npm test` before committing TypeScript, configuration, or test changes. This command includes the production compile, unit tests, and VS Code integration tests. For documentation-only changes, running the test suite is optional.

## Development Guidelines

- Keep changes small and focused.
- Prefer simple TypeScript over unnecessary abstractions.
- Keep scanner rules conservative to avoid noisy false positives.
- Do not add entropy detection until ignore and severity UX are stronger.
- Do not scan outside the current VS Code workspace.
- Respect ignored paths such as `node_modules`, `.git`, `dist`, `build`, and `coverage`.
- Preserve the current MVP behavior unless the task explicitly asks to change it.
- Update `docs/dev/development.md` when extension architecture, commands, settings, activation flow, diagnostics, quick fixes, scanning behavior, or ignore behavior changes.
- Update `docs/dev/rules.md` when detection rules, placeholder filtering, rule design guidance, or scanner rule handling changes.
- Update the root `README.md` when user-facing commands, settings, capabilities, or documentation links change.
- For documentation-only changes, a compile step is optional unless code or config changed.

## Commit And Branch Workflow

- Do not commit directly to `main`.
- Create a new branch before making commits.
- Use descriptive branch names such as `feature/workspace-scan`, `fix/ignore-warning`, or `docs/update-agent-instructions`.
- Stage files deliberately so each commit contains one logical change.
- Prefer multiple meaningful commits over one large mixed commit.
- Good commit split examples: scaffold, implementation, tests, documentation.
- Write concise commit messages in imperative mood.
- Confirm that `origin` uses an SSH URL before pushing. Do not replace repository credentials or switch the remote to HTTPS automatically.
- Push the feature branch over SSH with `git push -u origin <branch>` when the work is complete.
- Do not require or use GitHub CLI (`gh`) in agent workflows for this repository.
- After pushing, use the connected GitHub integration to check whether an open PR already exists for the current branch.
- If the integration cannot create or inspect PRs, use the signed-in GitHub web interface as the automatic fallback. SSH transports Git commits; pull requests are created through GitHub's API or web interface, not through the SSH protocol itself.
- If no PR exists for the branch, create a draft PR against `main` unless the user explicitly requests a ready-for-review PR.
- If an open PR already exists, do not create a duplicate PR; commit and push updates to the same branch so the ongoing PR updates.
- Do not merge the branch into `main`.
- Do not create a merge commit unless explicitly requested.
- The repository owner will review and merge PRs.

## Extension Release Workflow

When a user asks for a new release of the VS Code extension:

- Create a release or feature branch before making commits.
- Implement the requested features, fixes, or release prep.
- Run `npm ci`, `npm test`, `npm run test:release`, and `npm run verify:workflow-pins`.
- Bump the extension version with one of:
  - `npm version patch` for fixes, docs, or internal changes.
  - `npm version minor` for new user-facing features.
  - `npm version major` only for breaking behavior.
- Commit the release changes, push the branch, and create or update a PR against `main`.
- Do not merge the PR.
- Pull requests automatically exercise the credential-free `build` dry run. A manual `publish: false` run does the same.
- Wait for the repository owner to review and merge the release PR. Publish only after an explicit request by manually running `Publish release` from `main` with `publish: true` and `expected_version` exactly equal to `package.json`.
- Keep Node.js 22.23.2, `@vscode/vsce` 4.0.0, Ubuntu 24.04, and all reviewed action SHA pins unchanged unless the update itself is reviewed and tested.
- Marketplace publication must use the `marketplace` GitHub environment and OIDC trusted publishing. Never add or use `VSCE_PAT`, `--skip-duplicate`, `gh`, or `jq` in the release path.
- Restrict the `marketplace` environment to deployments from `main`. Require workflow run attempt `1` before invoking VSCE, persist the immutable Marketplace attempt receipt, and keep recovery on the original first-attempt artifact.
- The workflow builds once, verifies a strict three-file bundle, uploads the prebuilt VSIX to the Marketplace, then attaches the exact same original VSIX plus its checksum and manifest to the GitHub Release.
- Marketplace public downloads are signed/repackaged and are checked for exact version visibility, not byte equality. The GitHub asset retains the original recorded bytes.
- If Marketplace propagation is pending, rerun only the failed `publish-github` job from the same workflow run after the version becomes visible. Same-run partial GitHub drafts are resumable; foreign or mismatched drafts, tags, releases, and assets fail closed.
- A nonzero or ambiguous VSCE result requires explicit manual investigation. The Marketplace job must never run on a workflow re-run attempt; do not rerun the publisher or infer success from a pre-existing version.

See `docs/dev/development.md` for bundle contents, permissions, validation order, and recovery details.

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
