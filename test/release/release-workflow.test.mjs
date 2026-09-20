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
  assert.match(workflow, /PUBLISH: \$\{\{ github\.event_name == 'workflow_dispatch' && inputs\.publish && 'true' \|\| 'false' \}\}/);
  assert.match(workflow, /GITHUB_EVENT_NAME: \$\{\{ github\.event_name \}\}/);
  assert.match(workflow, /GITHUB_REF: \$\{\{ github\.ref \}\}/);
  assert.match(workflow, /if: \$\{\{ github\.event_name == 'workflow_dispatch' && inputs\.publish \}\}/g);
});

test("release workflow has exactly the build, Marketplace, and GitHub jobs with least privilege", async () => {
  const workflow = await readFile(workflowPath, "utf8");
  const jobs = workflow.slice(workflow.indexOf("jobs:\n") + "jobs:\n".length);
  const jobIds = [...jobs.matchAll(/^  ([a-z][a-z0-9-]+):$/gm)].map((match) => match[1]);
  assert.deepEqual(jobIds, ["build", "publish-marketplace", "publish-github"]);
  assert.match(workflow, /^permissions: \{\}$/m);

  const marketplaceJob = jobs.slice(jobs.indexOf("  publish-marketplace:"), jobs.indexOf("  publish-github:"));
  assert.match(marketplaceJob, /environment: marketplace/);
  assert.match(marketplaceJob, /permissions:\n      contents: read\n      id-token: write/);
  assert.doesNotMatch(marketplaceJob, /contents: write/);
  assert.doesNotMatch(marketplaceJob, /VSCE_PAT/);

  const githubJob = jobs.slice(jobs.indexOf("  publish-github:"));
  assert.match(githubJob, /permissions:\n      contents: write/);
  assert.doesNotMatch(githubJob, /id-token: write/);
});

test("release workflow builds once and reuses one run-id-keyed three-file artifact", async () => {
  const workflow = await readFile(workflowPath, "utf8");
  assert.equal((workflow.match(/\.\/node_modules\/\.bin\/vsce package/g) ?? []).length, 1);
  assert.equal((workflow.match(/release-helper\.mjs prepare$/gm) ?? []).length, 1);
  assert.match(workflow, /name: safe-code-release-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/);
  assert.equal((workflow.match(/name: safe-code-release-\$\{\{ github\.run_id \}\}-1/g) ?? []).length, 2);
  assert.match(workflow, /overwrite: false/);
  assert.match(workflow, /retention-days: 30/);
  assert.match(workflow, /if-no-files-found: error/);
  assert.match(workflow, /compression-level: 0/);
  assert.equal((workflow.match(/actions\/upload-artifact@/g) ?? []).length, 2);
  assert.equal((workflow.match(/actions\/download-artifact@/g) ?? []).length, 2);
  assert.doesNotMatch(workflow, /ref:\s*main/);
  assert.doesNotMatch(workflow, /@latest|\bgh\s|\bjq\s|VSCE_PAT/);
});

test("Marketplace trust and wording reflect OIDC publication plus version-only visibility", async () => {
  const workflow = await readFile(workflowPath, "utf8");
  const preflightIndex = workflow.indexOf("release-helper.mjs prepare-marketplace-attempt");
  const receiptIndex = workflow.indexOf("name: safe-code-marketplace-attempt-${{ github.run_id }}-${{ github.run_attempt }}");
  const publishIndex = workflow.indexOf("release-helper.mjs publish-marketplace");
  assert(preflightIndex > 0 && receiptIndex > preflightIndex && publishIndex > receiptIndex);
  assert.match(workflow, /path: \$\{\{ runner\.temp \}\}\/safe-code-marketplace-attempt\/marketplace-publication-attempt\.json/);
  const receiptStep = workflow.slice(receiptIndex, publishIndex);
  assert.match(receiptStep, /if-no-files-found: error/);
  assert.match(receiptStep, /overwrite: false/);
  assert.match(receiptStep, /retention-days: 30/);
  assert.equal((workflow.match(/WORKFLOW_RUN_ATTEMPT: \$\{\{ github\.run_attempt \}\}/g) ?? []).length, 2);
  assert.match(workflow, /Verify local artifact and publish its version to Marketplace/);
  assert.match(workflow, /Verify Marketplace version visibility/);
  assert.doesNotMatch(workflow, /Marketplace serves the exact|exact Marketplace artifact/);
  assert.match(workflow, /node scripts\/release-helper\.mjs publish-marketplace/);
  assert.match(workflow, /node scripts\/release-helper\.mjs verify-marketplace/);
});
