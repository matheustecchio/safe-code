import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

const workflowPath = path.resolve(".github/workflows/publish-github-release.yml");

test("release workflow exposes a safe build-only dry run and exact publication guard inputs", async () => {
  const workflow = await readFile(workflowPath, "utf8");
  assert.match(workflow, /\n  pull_request:\n/);
  assert.match(workflow, /\n  workflow_dispatch:\n/);
  assert.match(workflow, /publish:[\s\S]*?default: false[\s\S]*?type: boolean/);
  assert.match(workflow, /expected_version:[\s\S]*?default: ""[\s\S]*?type: string/);
  assert.match(workflow, /recover_1_0_0:[\s\S]*?default: false[\s\S]*?type: boolean/);
  assert.match(workflow, /recovery_confirmation_reference:[\s\S]*?default: ""[\s\S]*?type: string/);
  assert.match(workflow, /PUBLISH: \$\{\{ github\.event_name == 'workflow_dispatch' && inputs\.publish && 'true' \|\| 'false' \}\}/);
  assert.match(workflow, /GITHUB_EVENT_NAME: \$\{\{ github\.event_name \}\}/);
  assert.match(workflow, /GITHUB_REF: \$\{\{ github\.ref \}\}/);
  assert.equal((workflow.match(/if: \$\{\{ github\.event_name == 'workflow_dispatch' && inputs\.publish && !inputs\.recover_1_0_0 \}\}/g) ?? []).length, 1);
  assert.match(workflow, /build:[\s\S]*?if: \$\{\{ !inputs\.recover_1_0_0 \}\}/);
});

test("normal and incident-recovery jobs use separated least-privilege permissions", async () => {
  const workflow = await readFile(workflowPath, "utf8");
  const jobs = workflow.slice(workflow.indexOf("jobs:\n") + "jobs:\n".length);
  const jobIds = [...jobs.matchAll(/^  ([a-z][a-z0-9-]+):$/gm)].map((match) => match[1]);
  assert.deepEqual(jobIds, ["build", "publish-github", "recovery-preflight", "recovery-marketplace", "recovery-github"]);
  assert.match(workflow, /^permissions: \{\}$/m);

  const githubJob = jobs.slice(jobs.indexOf("  publish-github:"), jobs.indexOf("  recovery-preflight:"));
  assert.match(githubJob, /needs: build/);
  assert.match(githubJob, /permissions:\n      contents: write/);
  assert.doesNotMatch(githubJob, /id-token: write|environment: marketplace/);

  const recoveryPreflight = jobs.slice(jobs.indexOf("  recovery-preflight:"), jobs.indexOf("  recovery-marketplace:"));
  assert.match(recoveryPreflight, /permissions:\n      actions: read\n      contents: read/);
  assert.doesNotMatch(recoveryPreflight, /id-token: write|contents: write/);

  const recoveryMarketplace = jobs.slice(jobs.indexOf("  recovery-marketplace:"), jobs.indexOf("  recovery-github:"));
  assert.match(recoveryMarketplace, /environment: marketplace/);
  assert.match(recoveryMarketplace, /permissions:\n      actions: read\n      contents: read\n      id-token: write/);
  assert.doesNotMatch(recoveryMarketplace, /contents: write/);

  const recoveryGithub = jobs.slice(jobs.indexOf("  recovery-github:"));
  assert.match(recoveryGithub, /permissions:\n      actions: read\n      contents: write/);
  assert.doesNotMatch(recoveryGithub, /id-token: write/);
});

test("release workflow builds once and reuses one run-id-keyed three-file artifact", async () => {
  const workflow = await readFile(workflowPath, "utf8");
  assert.equal((workflow.match(/\.\/node_modules\/\.bin\/vsce package/g) ?? []).length, 1);
  assert.equal((workflow.match(/release-helper\.mjs prepare$/gm) ?? []).length, 1);
  assert.match(workflow, /name: safe-code-release-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/);
  assert.equal((workflow.match(/name: safe-code-release-\$\{\{ github\.run_id \}\}-1/g) ?? []).length, 1);
  assert.match(workflow, /overwrite: false/);
  assert.match(workflow, /retention-days: 30/);
  assert.match(workflow, /if-no-files-found: error/);
  assert.match(workflow, /compression-level: 0/);
  assert.equal((workflow.match(/actions\/upload-artifact@/g) ?? []).length, 2);
  assert.equal((workflow.match(/actions\/download-artifact@/g) ?? []).length, 9);
  assert.doesNotMatch(workflow, /ref:\s*main/);
  assert.doesNotMatch(workflow, /@latest|\bgh\s|\bjq\s|VSCE_PAT/);
});

test("ordinary releases publish to GitHub before a separate manual Marketplace upload", async () => {
  const workflow = await readFile(workflowPath, "utf8");
  const normal = workflow.slice(0, workflow.indexOf("  recovery-preflight:"));
  assert.match(normal, /Download build job release bundle/);
  assert.match(normal, /node scripts\/release-helper\.mjs publish-github/);
  assert.doesNotMatch(normal, /publish-marketplace|verify-marketplace|id-token: write/);
  assert.match(normal, /upload to Marketplace manually afterward/);
});

test("1.0.0 recovery is fixed to original artifacts, persists the decision, diagnoses OIDC, and preserves ordering", async () => {
  const workflow = await readFile(workflowPath, "utf8");
  const recovery = workflow.slice(workflow.indexOf("  recovery-preflight:"));
  assert.equal((recovery.match(/artifact-ids: 10773757838/g) ?? []).length, 3);
  assert.equal((recovery.match(/artifact-ids: 10772978663/g) ?? []).length, 3);
  assert.equal((recovery.match(/run-id: 35912409247/g) ?? []).length, 6);
  assert.equal((recovery.match(/repository: matheustecchio\/safe-code/g) ?? []).length, 6);
  assert.equal((recovery.match(/name: safe-code-recovery-decision-35912409247/g) ?? []).length, 3);
  assert.match(recovery, /path: \$\{\{ runner\.temp \}\}\/safe-code-recovery-decision\/marketplace-recovery-decision\.json/);

  const prepare = recovery.indexOf("release-helper.mjs prepare-recovery-decision");
  const persist = recovery.indexOf("Persist immutable recovery decision before publisher access");
  const diagnose = recovery.indexOf("release-helper.mjs diagnose-recovery-oidc");
  const publishMarketplace = recovery.indexOf("release-helper.mjs publish-recovery-marketplace");
  const publishGithub = recovery.indexOf("release-helper.mjs publish-recovery-github");
  assert(prepare > 0 && persist > prepare && diagnose > persist && publishMarketplace > diagnose && publishGithub > publishMarketplace);
  assert.equal((recovery.match(/release-helper\.mjs publish-recovery-marketplace/g) ?? []).length, 1);
  assert.match(recovery, /needs: recovery-preflight/);
  assert.match(recovery, /needs: recovery-marketplace/);
  assert.doesNotMatch(recovery, /vsce package|--skip-duplicate|VSCE_PAT/);
});
