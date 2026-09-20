#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const RELEASE_SCHEMA_VERSION = 1;
export const PINNED_NODE_VERSION = "22.23.2";
export const PINNED_VSCE_VERSION = "4.0.0";
export const MAX_MARKETPLACE_WAIT_MS = 15 * 60 * 1000;
export const MARKETPLACE_ATTEMPT_FILE = "marketplace-publication-attempt.json";

const MAX_JSON_BYTES = 1024 * 1024;
const MAX_ASSET_BYTES = 512 * 1024 * 1024;
const FULL_SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const RUN_ID = /^[1-9][0-9]*$/;
const TOOL_VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const EXTENSION_ID = /^[A-Za-z0-9][A-Za-z0-9-]*\.[A-Za-z0-9][A-Za-z0-9-]*$/;
const GITHUB_API_VERSION = "2022-11-28";
const MANIFEST_FILE = "release-manifest.json";
const GITHUB_API_ORIGIN = "https://api.github.com";
const GITHUB_UPLOAD_ORIGIN = "https://uploads.github.com";
const MARKETPLACE_ORIGIN = "https://marketplace.visualstudio.com";
const responseTimeouts = new WeakMap();

const manifestKeys = [
  "schemaVersion",
  "extensionId",
  "version",
  "tag",
  "repository",
  "sourceCommit",
  "workflowRunId",
  "nodeVersion",
  "npmVersion",
  "vsceVersion",
  "assetFile",
  "assetSize",
  "sha256",
  "checksumFile",
  "manifestFile",
];

function fail(message) {
  throw new Error(message);
}

function assert(condition, message) {
  if (!condition) {
    fail(message);
  }
}

function assertPlainObject(value, label) {
  assert(value !== null && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
}

function assertExactKeys(value, expectedKeys, label) {
  assertPlainObject(value, label);
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  assert(JSON.stringify(actual) === JSON.stringify(expected), `${label} has unexpected or missing fields`);
}

function assertString(value, pattern, label) {
  assert(typeof value === "string" && pattern.test(value), `${label} is invalid`);
}

function parsePublishFlag(value) {
  if (value === "true") {
    return true;
  }
  if (value === "false" || value === "" || value === undefined) {
    return false;
  }
  fail("PUBLISH must be exactly true or false");
}

export function validatePublicationGuard({ publish, githubEventName, githubRef, expectedVersion, packageVersion }) {
  const shouldPublish = typeof publish === "boolean" ? publish : parsePublishFlag(publish);
  assertString(packageVersion, VERSION, "package version");

  if (!shouldPublish) {
    return false;
  }

  assert(githubEventName === "workflow_dispatch", "Publication is allowed only from workflow_dispatch");
  assert(githubRef === "refs/heads/main", "Publication is allowed only from refs/heads/main");
  assert(typeof expectedVersion === "string" && expectedVersion.length > 0, "expected_version is required for publication");
  assert(VERSION.test(expectedVersion), "expected_version is not a canonical version");
  assert(expectedVersion === packageVersion, "expected_version does not match package.json");
  return true;
}

export function validateMarketplaceRunAttempt(workflowRunAttempt) {
  assertString(workflowRunAttempt, RUN_ID, "workflow run attempt");
  assert(workflowRunAttempt === "1", "Marketplace publication is allowed only on the first workflow run attempt");
  return true;
}

function normalizeRepositoryUrl(value) {
  assert(typeof value === "string", "package repository URL is missing");
  const match = value.match(/^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/);
  assert(match, "package repository must be an HTTPS GitHub repository URL");
  return match[1];
}

function commandOutput(command, args) {
  return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

export async function readDetachedGitHead(workspace) {
  const dotGit = path.join(workspace, ".git");
  const dotGitStat = await lstat(dotGit);
  let gitDirectory = dotGit;
  if (dotGitStat.isFile()) {
    const pointer = (await readFile(dotGit, "utf8")).trim();
    const match = pointer.match(/^gitdir: (.+)$/);
    assert(match, ".git file is malformed");
    gitDirectory = path.resolve(workspace, match[1]);
  } else {
    assert(dotGitStat.isDirectory() && !dotGitStat.isSymbolicLink(), ".git must be a directory or gitdir pointer file");
  }
  const head = (await readFile(path.join(gitDirectory, "HEAD"), "utf8")).trim();
  assertString(head, FULL_SHA, "detached Git HEAD");
  return head;
}

async function sha256File(filePath) {
  const bytes = await readFile(filePath);
  assert(bytes.byteLength <= MAX_ASSET_BYTES, `${path.basename(filePath)} exceeds the release asset size limit`);
  return createHash("sha256").update(bytes).digest("hex");
}

function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function assertRegularFile(filePath, label) {
  const stat = await lstat(filePath);
  assert(stat.isFile() && !stat.isSymbolicLink(), `${label} must be a regular file and not a symbolic link`);
  return stat;
}

async function assertDirectoryEntries(directory, expectedNames) {
  const stat = await lstat(directory);
  assert(stat.isDirectory() && !stat.isSymbolicLink(), "release directory must be a directory and not a symbolic link");
  const entries = (await readdir(directory)).sort();
  const expected = [...expectedNames].sort();
  assert(JSON.stringify(entries) === JSON.stringify(expected), `release directory must contain exactly: ${expected.join(", ")}`);
  for (const name of expected) {
    await assertRegularFile(path.join(directory, name), name);
  }
}

async function readBoundedJsonFile(filePath, label) {
  const bytes = await readFile(filePath);
  assert(bytes.byteLength <= MAX_JSON_BYTES, `${label} is too large`);
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    fail(`${label} is not valid JSON`);
  }
  return value;
}

function validateManifestShape(manifest) {
  assertExactKeys(manifest, manifestKeys, "release manifest");
  assert(manifest.schemaVersion === RELEASE_SCHEMA_VERSION, "release manifest schemaVersion is unsupported");
  assertString(manifest.extensionId, EXTENSION_ID, "release manifest extensionId");
  assertString(manifest.version, VERSION, "release manifest version");
  assert(manifest.tag === `v${manifest.version}`, "release manifest tag is not canonical");
  assertString(manifest.repository, REPOSITORY, "release manifest repository");
  assertString(manifest.sourceCommit, FULL_SHA, "release manifest sourceCommit");
  assertString(manifest.workflowRunId, RUN_ID, "release manifest workflowRunId");
  assert(manifest.nodeVersion === PINNED_NODE_VERSION, `release manifest nodeVersion must be ${PINNED_NODE_VERSION}`);
  assertString(manifest.npmVersion, TOOL_VERSION, "release manifest npmVersion");
  assert(manifest.vsceVersion === PINNED_VSCE_VERSION, `release manifest vsceVersion must be ${PINNED_VSCE_VERSION}`);
  assert(manifest.assetFile === `safe-code-${manifest.version}.vsix`, "release manifest assetFile is not canonical");
  assert(Number.isSafeInteger(manifest.assetSize) && manifest.assetSize > 0 && manifest.assetSize <= MAX_ASSET_BYTES, "release manifest assetSize is invalid");
  assertString(manifest.sha256, SHA256, "release manifest sha256");
  assert(manifest.checksumFile === `${manifest.assetFile}.sha256`, "release manifest checksumFile is not canonical");
  assert(manifest.manifestFile === MANIFEST_FILE, "release manifest manifestFile is not canonical");
  return manifest;
}

function validateExpectedManifest(manifest, expected = {}) {
  const comparisons = {
    repository: expected.repository,
    sourceCommit: expected.sourceCommit,
    workflowRunId: expected.workflowRunId,
    version: expected.version,
    nodeVersion: expected.nodeVersion,
    vsceVersion: expected.vsceVersion,
  };
  for (const [field, expectedValue] of Object.entries(comparisons)) {
    if (expectedValue !== undefined && expectedValue !== "") {
      assert(manifest[field] === expectedValue, `release manifest ${field} does not match the expected value`);
    }
  }
}

export async function verifyReleaseBundle(directory, expected = {}) {
  const manifestPath = path.join(directory, MANIFEST_FILE);
  await assertRegularFile(manifestPath, MANIFEST_FILE);
  const manifest = validateManifestShape(await readBoundedJsonFile(manifestPath, "release manifest"));
  await assertDirectoryEntries(directory, [manifest.assetFile, manifest.checksumFile, manifest.manifestFile]);
  validateExpectedManifest(manifest, expected);

  const assetPath = path.join(directory, manifest.assetFile);
  const assetStat = await assertRegularFile(assetPath, manifest.assetFile);
  assert(assetStat.size === manifest.assetSize, "VSIX size does not match the release manifest");
  assert(await sha256File(assetPath) === manifest.sha256, "VSIX checksum does not match the release manifest");

  const checksumText = await readFile(path.join(directory, manifest.checksumFile), "utf8");
  assert(checksumText === `${manifest.sha256}  ${manifest.assetFile}\n`, "checksum file is not canonical or does not match the VSIX");
  return manifest;
}

export async function prepareMarketplaceAttemptReceipt(directory, manifest, workflowRunAttempt) {
  validateManifestShape(manifest);
  validateMarketplaceRunAttempt(workflowRunAttempt);
  const resolvedDirectory = path.resolve(directory);
  assert(resolvedDirectory !== path.parse(resolvedDirectory).root, "Marketplace attempt directory must not be a filesystem root");
  await mkdir(directory, { recursive: true });
  await assertDirectoryEntries(directory, []);

  const receipt = {
    schemaVersion: RELEASE_SCHEMA_VERSION,
    kind: "marketplace-publication-attempt",
    repository: manifest.repository,
    sourceCommit: manifest.sourceCommit,
    workflowRunId: manifest.workflowRunId,
    workflowRunAttempt,
    extensionId: manifest.extensionId,
    version: manifest.version,
    assetFile: manifest.assetFile,
    sha256: manifest.sha256,
  };
  await writeFile(
    path.join(directory, MARKETPLACE_ATTEMPT_FILE),
    `${JSON.stringify(receipt, null, 2)}\n`,
    { flag: "wx", mode: 0o600 },
  );
  await assertDirectoryEntries(directory, [MARKETPLACE_ATTEMPT_FILE]);
  return receipt;
}

function writeOutputs(outputPath, values) {
  if (!outputPath) {
    return;
  }
  const lines = Object.entries(values).map(([key, value]) => `${key}=${value}\n`).join("");
  return writeFile(outputPath, lines, { flag: "a" });
}

export async function prepareReleaseBundle({
  workspace,
  releaseDirectory,
  sourceVsix,
  repository,
  sourceCommit,
  workflowRunId,
  githubEventName,
  githubRef,
  expectedVersion,
  publish,
  nodeVersion,
  npmVersion,
  vsceVersion,
  headCommit,
  packageJson,
  outputPath,
}) {
  assertString(repository, REPOSITORY, "repository");
  assertString(sourceCommit, FULL_SHA, "source commit");
  assert(headCommit === sourceCommit, "checked-out HEAD does not match the workflow event SHA");
  assertString(workflowRunId, RUN_ID, "workflow run id");
  assert(nodeVersion === PINNED_NODE_VERSION, `Node.js ${PINNED_NODE_VERSION} is required`);
  assert(vsceVersion === PINNED_VSCE_VERSION, `VSCE ${PINNED_VSCE_VERSION} is required`);
  assertString(npmVersion, TOOL_VERSION, "npm version");
  assertExactKeys(packageJson.repository, ["type", "url"], "package repository");
  assert(packageJson.repository.type === "git", "package repository type must be git");
  assert(normalizeRepositoryUrl(packageJson.repository.url) === repository, "package repository does not match GITHUB_REPOSITORY");
  assert(packageJson.devDependencies?.["@vscode/vsce"] === PINNED_VSCE_VERSION, `package.json must pin @vscode/vsce exactly to ${PINNED_VSCE_VERSION}`);
  assertString(packageJson.publisher, /^[A-Za-z0-9][A-Za-z0-9-]*$/, "package publisher");
  assertString(packageJson.name, /^[A-Za-z0-9][A-Za-z0-9-]*$/, "package name");
  assertString(packageJson.version, VERSION, "package version");
  validatePublicationGuard({ publish, githubEventName, githubRef, expectedVersion, packageVersion: packageJson.version });

  const resolvedReleaseDirectory = path.resolve(releaseDirectory);
  const resolvedSourceVsix = path.resolve(sourceVsix);
  assert(resolvedReleaseDirectory !== path.parse(resolvedReleaseDirectory).root, "release directory must not be a filesystem root");
  assert(path.dirname(resolvedSourceVsix) === resolvedReleaseDirectory, "source VSIX must be inside the release directory");
  assert(path.basename(resolvedSourceVsix) === "unversioned.vsix", "source VSIX must use the expected temporary filename");
  await mkdir(releaseDirectory, { recursive: true });
  await assertDirectoryEntries(releaseDirectory, [path.basename(sourceVsix)]);
  await assertRegularFile(sourceVsix, "source VSIX");

  const assetFile = `safe-code-${packageJson.version}.vsix`;
  const assetPath = path.join(releaseDirectory, assetFile);
  assert(path.resolve(sourceVsix) !== path.resolve(assetPath), "source VSIX must use a temporary filename");
  await rename(sourceVsix, assetPath);
  const assetStat = await assertRegularFile(assetPath, assetFile);
  assert(assetStat.size > 0 && assetStat.size <= MAX_ASSET_BYTES, "VSIX size is invalid");
  const digest = await sha256File(assetPath);
  const manifest = {
    schemaVersion: RELEASE_SCHEMA_VERSION,
    extensionId: `${packageJson.publisher}.${packageJson.name}`,
    version: packageJson.version,
    tag: `v${packageJson.version}`,
    repository,
    sourceCommit,
    workflowRunId,
    nodeVersion,
    npmVersion,
    vsceVersion,
    assetFile,
    assetSize: assetStat.size,
    sha256: digest,
    checksumFile: `${assetFile}.sha256`,
    manifestFile: MANIFEST_FILE,
  };
  validateManifestShape(manifest);
  await writeFile(path.join(releaseDirectory, manifest.checksumFile), `${digest}  ${assetFile}\n`, { flag: "wx" });
  await writeFile(path.join(releaseDirectory, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
  await verifyReleaseBundle(releaseDirectory, { repository, sourceCommit, workflowRunId, version: packageJson.version });
  await writeOutputs(outputPath, {
    version: manifest.version,
    tag: manifest.tag,
    extension_id: manifest.extensionId,
    asset_name: manifest.assetFile,
    sha256: manifest.sha256,
    source_commit: manifest.sourceCommit,
    workflow_run_id: manifest.workflowRunId,
  });
  return manifest;
}

function githubHeaders(token, extra = {}) {
  assert(typeof token === "string" && token.length > 0, "GitHub token is required");
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": GITHUB_API_VERSION,
    "User-Agent": "safe-code-release-workflow",
    ...extra,
  };
}

function validateGithubUrl(rawUrl, allowedHosts) {
  const url = new URL(rawUrl);
  assert(url.protocol === "https:" && allowedHosts.includes(url.host), `Refusing unexpected GitHub API origin ${url.origin}`);
  return url;
}

async function fetchWithTimeout(fetchImpl, url, options, timeoutMs = 30_000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { ...options, signal: controller.signal });
    responseTimeouts.set(response, timeout);
    return response;
  } catch (error) {
    clearTimeout(timeout);
    throw error;
  }
}

function releaseResponseTimeout(response) {
  const timeout = responseTimeouts.get(response);
  if (timeout !== undefined) {
    clearTimeout(timeout);
    responseTimeouts.delete(response);
  }
}

function discardResponse(response) {
  releaseResponseTimeout(response);
  response.body?.cancel().catch(() => {});
}

export async function responseBytes(response, label, maximumBytes = MAX_ASSET_BYTES) {
  try {
    const declaredLength = response.headers.get("content-length");
    if (declaredLength !== null) {
      const parsed = Number(declaredLength);
      assert(Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= maximumBytes, `${label} response is too large`);
    }
    if (!response.body) {
      return Buffer.alloc(0);
    }
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel();
        fail(`${label} response is too large`);
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, total);
  } finally {
    releaseResponseTimeout(response);
  }
}

async function responseJson(response, label) {
  const bytes = await responseBytes(response, label, MAX_JSON_BYTES);
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    fail(`${label} response was not valid JSON`);
  }
}

export async function githubRequest(fetchImpl, token, rawUrl, {
  method = "GET",
  body,
  expectedStatuses = [200],
  allowNotFound = false,
  upload = false,
  accept = "application/vnd.github+json",
} = {}) {
  const url = validateGithubUrl(rawUrl, [upload ? "uploads.github.com" : "api.github.com"]);
  const headers = githubHeaders(token, {
    Accept: accept,
    ...(body === undefined ? {} : {
    "Content-Type": Buffer.isBuffer(body) ? "application/octet-stream" : "application/json",
    }),
  });
  const response = await fetchWithTimeout(fetchImpl, url, {
    method,
    headers,
    body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body),
    redirect: "manual",
  });
  if (response.status === 404 && allowNotFound) {
    discardResponse(response);
    return null;
  }
  if (!expectedStatuses.includes(response.status)) {
    discardResponse(response);
    fail(`GitHub API ${method} ${url.pathname} failed with HTTP ${response.status}`);
  }
  if (response.status === 204) {
    discardResponse(response);
  }
  return response;
}

function githubApiUrl(repository, suffix) {
  assertString(repository, REPOSITORY, "repository");
  return `${GITHUB_API_ORIGIN}/repos/${repository}${suffix}`;
}

function validateReleaseAsset(asset, { allowStarter = false } = {}) {
  assertPlainObject(asset, "GitHub release asset");
  assert(Number.isSafeInteger(asset.id) && asset.id > 0, "GitHub release asset id is invalid");
  assert(typeof asset.name === "string" && asset.name.length > 0, "GitHub release asset name is invalid");
  assert(Number.isSafeInteger(asset.size) && asset.size >= 0 && asset.size <= MAX_ASSET_BYTES, "GitHub release asset size is invalid");
  assert(asset.state === "uploaded" || (allowStarter && asset.state === "starter"), "GitHub release asset has an invalid state");
  if (asset.digest !== undefined && asset.digest !== null) {
    assert(typeof asset.digest === "string" && /^sha256:[0-9a-f]{64}$/.test(asset.digest), "GitHub release asset digest is invalid");
  }
  return asset;
}

function validateRelease(release) {
  assertPlainObject(release, "GitHub release");
  assert(Number.isSafeInteger(release.id) && release.id > 0, "GitHub release id is invalid");
  assert(typeof release.tag_name === "string", "GitHub release tag is invalid");
  assert(typeof release.target_commitish === "string", "GitHub release target is invalid");
  assert(typeof release.name === "string", "GitHub release name is invalid");
  assert(typeof release.body === "string", "GitHub release body is invalid");
  assert(typeof release.draft === "boolean", "GitHub release draft state is invalid");
  assert(typeof release.prerelease === "boolean", "GitHub release prerelease state is invalid");
  assert(Array.isArray(release.assets) && release.assets.length <= 20, "GitHub release assets are invalid");
  release.assets.forEach((asset) => validateReleaseAsset(asset, { allowStarter: release.draft }));
  return release;
}

function markerMetadata(manifest) {
  return {
    schemaVersion: RELEASE_SCHEMA_VERSION,
    repository: manifest.repository,
    sourceCommit: manifest.sourceCommit,
    workflowRunId: manifest.workflowRunId,
    version: manifest.version,
    tag: manifest.tag,
    sha256: manifest.sha256,
    assets: [manifest.assetFile, manifest.checksumFile, manifest.manifestFile],
  };
}

export function releaseBody(manifest) {
  const marker = Buffer.from(JSON.stringify(markerMetadata(manifest)), "utf8").toString("base64url");
  return `Built once from commit \`${manifest.sourceCommit}\` with Node.js ${manifest.nodeVersion}, npm ${manifest.npmVersion}, and @vscode/vsce ${manifest.vsceVersion}.\n\nVSIX SHA-256: \`${manifest.sha256}\`\n\n<!-- safe-code-release:${marker} -->`;
}

function parseReleaseMarker(body) {
  const matches = [...body.matchAll(/<!-- safe-code-release:([A-Za-z0-9_-]+) -->/g)];
  assert(matches.length === 1, "GitHub draft release provenance marker is missing or duplicated");
  let metadata;
  try {
    metadata = JSON.parse(Buffer.from(matches[0][1], "base64url").toString("utf8"));
  } catch {
    fail("GitHub draft release provenance marker is malformed");
  }
  const keys = ["schemaVersion", "repository", "sourceCommit", "workflowRunId", "version", "tag", "sha256", "assets"];
  assertExactKeys(metadata, keys, "GitHub draft release provenance");
  assert(Array.isArray(metadata.assets) && new Set(metadata.assets).size === 3, "GitHub draft release provenance assets are invalid");
  return metadata;
}

async function localAssets(directory, manifest) {
  const names = [manifest.assetFile, manifest.checksumFile, manifest.manifestFile];
  const assets = [];
  for (const name of names) {
    const filePath = path.join(directory, name);
    const bytes = await readFile(filePath);
    assets.push({ name, filePath, bytes, size: bytes.byteLength, sha256: sha256Bytes(bytes) });
  }
  return assets;
}

async function downloadGithubAsset(fetchImpl, token, repository, assetId) {
  const response = await githubRequest(fetchImpl, token, githubApiUrl(repository, `/releases/assets/${assetId}`), {
    expectedStatuses: [200, 302],
    accept: "application/octet-stream",
  });
  if (response.status === 200) {
    return responseBytes(response, "GitHub release asset");
  }
  const location = response.headers.get("location");
  discardResponse(response);
  assert(location, "GitHub release asset redirect is missing a location");
  const redirect = new URL(location);
  assert(redirect.protocol === "https:" && redirect.hostname.endsWith(".githubusercontent.com"), "GitHub release asset redirect has an unexpected origin");
  const downloaded = await fetchWithTimeout(fetchImpl, redirect, { method: "GET", redirect: "error" });
  assert(downloaded.status === 200, `GitHub release asset download failed with HTTP ${downloaded.status}`);
  return responseBytes(downloaded, "GitHub release asset");
}

async function verifyRemoteAsset(fetchImpl, token, repository, remoteAsset, localAsset) {
  validateReleaseAsset(remoteAsset);
  assert(remoteAsset.name === localAsset.name, `GitHub release asset name ${remoteAsset.name} is unexpected`);
  assert(remoteAsset.size === localAsset.size, `GitHub release asset ${remoteAsset.name} has the wrong size`);
  if (remoteAsset.digest !== undefined && remoteAsset.digest !== null) {
    assert(remoteAsset.digest === `sha256:${localAsset.sha256}`, `GitHub release asset ${remoteAsset.name} has the wrong digest`);
  }
  const downloaded = await downloadGithubAsset(fetchImpl, token, repository, remoteAsset.id);
  assert(downloaded.equals(localAsset.bytes), `GitHub release asset ${remoteAsset.name} bytes do not match the local artifact`);
}

async function validateReleaseIdentity(fetchImpl, token, manifest, release, assets, { draft, requireComplete }) {
  validateRelease(release);
  assert(release.draft === draft, "GitHub release state does not match the expected recovery state");
  assert(release.prerelease === false, "GitHub release must not be a prerelease");
  assert(release.tag_name === manifest.tag, "GitHub release tag does not match the manifest");
  assert(release.target_commitish === manifest.sourceCommit, "GitHub release targets a different commit");
  assert(release.name === `Safe Code ${manifest.version}`, "GitHub release name does not match the manifest");
  const provenance = parseReleaseMarker(release.body);
  assert(JSON.stringify(provenance) === JSON.stringify(markerMetadata(manifest)), "GitHub release provenance does not match this workflow run");

  if (requireComplete) {
    assert(release.assets.length === assets.length, "GitHub release must contain exactly the three release assets");
    assert(release.assets.every((asset) => asset.state === "uploaded"), "GitHub release contains an incomplete asset");
  }

  const localByName = new Map(assets.map((asset) => [asset.name, asset]));
  const seen = new Set();
  for (const remoteAsset of release.assets) {
    assert(!seen.has(remoteAsset.name), `GitHub draft has duplicate asset ${remoteAsset.name}`);
    seen.add(remoteAsset.name);
    const localAsset = localByName.get(remoteAsset.name);
    assert(localAsset, `GitHub draft has unexpected asset ${remoteAsset.name}`);
    if (remoteAsset.state === "uploaded") {
      await verifyRemoteAsset(fetchImpl, token, manifest.repository, remoteAsset, localAsset);
    }
  }
  return release;
}

async function parseTagCommit(response, manifest) {
  const tag = await responseJson(response, "GitHub tag");
  assertPlainObject(tag, "GitHub tag");
  assertPlainObject(tag.object, "GitHub tag object");
  assert(tag.object.type === "commit" && tag.object.sha === manifest.sourceCommit, "Published tag does not point to the source commit");
  return tag;
}

export async function preflightGithubRelease({ fetchImpl = fetch, token, directory, manifest }) {
  const assets = await localAssets(directory, manifest);
  const releasesResponse = await githubRequest(fetchImpl, token, githubApiUrl(manifest.repository, "/releases?per_page=100"));
  assert(!/rel="next"/.test(releasesResponse.headers.get("link") ?? ""), "Repository has more than 100 releases; refusing an incomplete preflight");
  const releases = await responseJson(releasesResponse, "GitHub releases");
  assert(Array.isArray(releases) && releases.length <= 100, "GitHub releases response is invalid");
  const matching = releases.filter((release) => release?.tag_name === manifest.tag);
  assert(matching.length <= 1, `Multiple GitHub releases use tag ${manifest.tag}`);
  const tagResponse = await githubRequest(fetchImpl, token, githubApiUrl(manifest.repository, `/git/ref/tags/${encodeURIComponent(manifest.tag)}`), {
    allowNotFound: true,
  });
  if (matching.length === 0) {
    if (tagResponse !== null) {
      discardResponse(tagResponse);
      fail(`Git tag ${manifest.tag} already exists; refusing publication`);
    }
    return { state: "absent", assets };
  }
  if (matching[0].draft) {
    if (tagResponse !== null) {
      discardResponse(tagResponse);
      fail(`Git tag ${manifest.tag} exists for a draft release; refusing recovery`);
    }
    await validateReleaseIdentity(fetchImpl, token, manifest, matching[0], assets, { draft: true, requireComplete: false });
    return { state: "draft", release: matching[0], assets };
  }
  assert(tagResponse !== null, "Published GitHub release has no matching tag");
  await parseTagCommit(tagResponse, manifest);
  await validateReleaseIdentity(fetchImpl, token, manifest, matching[0], assets, { draft: false, requireComplete: true });
  return { state: "published", release: matching[0], assets };
}

async function getRelease(fetchImpl, token, repository, releaseId) {
  const response = await githubRequest(fetchImpl, token, githubApiUrl(repository, `/releases/${releaseId}`));
  return validateRelease(await responseJson(response, "GitHub release"));
}

async function uploadGithubAsset(fetchImpl, token, manifest, releaseId, localAsset) {
  const url = `${GITHUB_UPLOAD_ORIGIN}/repos/${manifest.repository}/releases/${releaseId}/assets?name=${encodeURIComponent(localAsset.name)}`;
  const response = await githubRequest(fetchImpl, token, url, {
    method: "POST",
    body: localAsset.bytes,
    expectedStatuses: [201],
    upload: true,
  });
  const asset = validateReleaseAsset(await responseJson(response, "GitHub asset upload"));
  assert(asset.name === localAsset.name, "GitHub asset upload returned the wrong name");
  assert(asset.size === localAsset.size, "GitHub asset upload returned the wrong size");
  if (asset.digest !== undefined && asset.digest !== null) {
    assert(asset.digest === `sha256:${localAsset.sha256}`, "GitHub asset upload returned the wrong digest");
  }
  return asset;
}

export async function publishGithubRelease({ fetchImpl = fetch, token, directory, manifest }) {
  const preflight = await preflightGithubRelease({ fetchImpl, token, directory, manifest });
  if (preflight.state === "published") {
    return preflight.release;
  }
  let release;
  if (preflight.state === "absent") {
    const response = await githubRequest(fetchImpl, token, githubApiUrl(manifest.repository, "/releases"), {
      method: "POST",
      body: {
        tag_name: manifest.tag,
        target_commitish: manifest.sourceCommit,
        name: `Safe Code ${manifest.version}`,
        body: releaseBody(manifest),
        draft: true,
        prerelease: false,
        generate_release_notes: true,
      },
      expectedStatuses: [201],
    });
    release = validateRelease(await responseJson(response, "GitHub draft creation"));
    await validateReleaseIdentity(fetchImpl, token, manifest, release, preflight.assets, { draft: true, requireComplete: false });
  } else {
    release = preflight.release;
  }

  for (const remoteAsset of release.assets.filter((asset) => asset.state === "starter")) {
    await githubRequest(fetchImpl, token, githubApiUrl(manifest.repository, `/releases/assets/${remoteAsset.id}`), {
      method: "DELETE",
      expectedStatuses: [204],
    });
  }
  const existingNames = new Set(release.assets.filter((asset) => asset.state === "uploaded").map((asset) => asset.name));
  for (const localAsset of preflight.assets) {
    if (!existingNames.has(localAsset.name)) {
      await uploadGithubAsset(fetchImpl, token, manifest, release.id, localAsset);
    }
  }

  release = await getRelease(fetchImpl, token, manifest.repository, release.id);
  await validateReleaseIdentity(fetchImpl, token, manifest, release, preflight.assets, { draft: true, requireComplete: true });

  const publishResponse = await githubRequest(fetchImpl, token, githubApiUrl(manifest.repository, `/releases/${release.id}`), {
    method: "PATCH",
    body: { draft: false, make_latest: "true" },
  });
  const published = validateRelease(await responseJson(publishResponse, "GitHub release publication"));
  assert(!published.draft && published.tag_name === manifest.tag && published.target_commitish === manifest.sourceCommit, "GitHub release was not published as expected");

  const confirmed = await getRelease(fetchImpl, token, manifest.repository, release.id);
  await validateReleaseIdentity(fetchImpl, token, manifest, confirmed, preflight.assets, { draft: false, requireComplete: true });
  const tagResponse = await githubRequest(fetchImpl, token, githubApiUrl(manifest.repository, `/git/ref/tags/${encodeURIComponent(manifest.tag)}`));
  await parseTagCommit(tagResponse, manifest);
  return confirmed;
}

function marketplacePackageUrl(manifest) {
  const [publisher, extensionName] = manifest.extensionId.split(".");
  return `${MARKETPLACE_ORIGIN}/_apis/public/gallery/publishers/${encodeURIComponent(publisher)}/vsextensions/${encodeURIComponent(extensionName)}/${encodeURIComponent(manifest.version)}/vspackage`;
}

function allowedMarketplaceHost(hostname) {
  return hostname === "marketplace.visualstudio.com" || hostname.endsWith(".vsassets.io");
}

async function marketplaceResponse(fetchImpl, rawUrl, deadline, now, redirects = 0) {
  const url = new URL(rawUrl);
  assert(url.protocol === "https:" && allowedMarketplaceHost(url.hostname), `Refusing unexpected Marketplace origin ${url.origin}`);
  const remaining = deadline - now();
  assert(remaining > 0, "Marketplace request exceeded its bounded timeout");
  const response = await fetchWithTimeout(fetchImpl, url, {
    method: "GET",
    headers: { "User-Agent": "safe-code-release-workflow" },
    redirect: "manual",
  }, remaining);
  if ([301, 302, 303, 307, 308].includes(response.status)) {
    const location = response.headers.get("location");
    discardResponse(response);
    assert(redirects < 3, "Marketplace download redirected too many times");
    assert(location, "Marketplace redirect is missing a location");
    return marketplaceResponse(fetchImpl, new URL(location, url).toString(), deadline, now, redirects + 1);
  }
  return response;
}

export async function probeMarketplaceArtifact(fetchImpl, manifest, { timeoutMs = 30_000, now = Date.now } = {}) {
  assert(timeoutMs > 0 && timeoutMs <= 30_000, "Marketplace request timeout is invalid");
  const response = await marketplaceResponse(fetchImpl, marketplacePackageUrl(manifest), now() + timeoutMs, now);
  if (response.status === 404) {
    discardResponse(response);
    return { state: "absent" };
  }
  if (response.status !== 200) {
    discardResponse(response);
    fail(`Marketplace verification failed with HTTP ${response.status}`);
  }
  const bytes = await responseBytes(response, "Marketplace VSIX");
  assert(bytes.byteLength >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b, "Marketplace returned a malformed VSIX package");
  return { state: "present", servedSize: bytes.byteLength };
}

export async function requireMarketplaceVersionVisible(fetchImpl, manifest) {
  const result = await probeMarketplaceArtifact(fetchImpl, manifest);
  assert(result.state === "present", "Marketplace version is not visible; rerun only the GitHub publication job later");
  return result;
}

export async function waitForMarketplace({
  fetchImpl = fetch,
  manifest,
  maximumWaitMs = MAX_MARKETPLACE_WAIT_MS,
  intervalMs = 15_000,
  allowPending = false,
  now = Date.now,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
}) {
  assert(maximumWaitMs > 0 && maximumWaitMs <= MAX_MARKETPLACE_WAIT_MS, "Marketplace wait must be between 1 ms and 15 minutes");
  assert(intervalMs > 0 && intervalMs <= maximumWaitMs, "Marketplace polling interval is invalid");
  const deadline = now() + maximumWaitMs;
  while (true) {
    const remaining = deadline - now();
    if (remaining <= 0) {
      if (allowPending) {
        return { state: "accepted-pending-propagation" };
      }
      fail(`Marketplace version was not visible within ${maximumWaitMs} ms`);
    }
    const result = await probeMarketplaceArtifact(fetchImpl, manifest, { timeoutMs: Math.min(30_000, remaining), now });
    if (result.state === "present") {
      return result;
    }
    if (now() >= deadline) {
      if (allowPending) {
        return { state: "accepted-pending-propagation" };
      }
      fail(`Marketplace version was not visible within ${maximumWaitMs} ms`);
    }
    await sleep(Math.min(intervalMs, deadline - now()));
  }
}

export async function publishMarketplaceRelease({
  fetchImpl = fetch,
  token,
  directory,
  manifest,
  workflowRunAttempt,
  runPublisher,
  waitOptions = {},
}) {
  validateMarketplaceRunAttempt(workflowRunAttempt);
  await preflightMarketplaceRelease({ fetchImpl, token, directory, manifest });
  await runPublisher(path.join(directory, manifest.assetFile));
  const visibility = await waitForMarketplace({ fetchImpl, manifest, allowPending: true, ...waitOptions });
  return { state: visibility.state === "present" ? "published-and-visible" : visibility.state };
}

export async function preflightMarketplaceRelease({ fetchImpl = fetch, token, directory, manifest }) {
  const githubState = await preflightGithubRelease({ fetchImpl, token, directory, manifest });
  assert(githubState.state === "absent", "No GitHub tag or release visible to the read-scoped Marketplace job may exist before publication");
  const existing = await probeMarketplaceArtifact(fetchImpl, manifest);
  assert(existing.state === "absent", "Marketplace version already exists; refusing to publish or infer its origin");
}

function requireEnvironment(name) {
  const value = process.env[name];
  assert(typeof value === "string" && value.length > 0, `${name} is required`);
  return value;
}

async function loadBundleFromEnvironment({ verifyTools = false } = {}) {
  const directory = requireEnvironment("RELEASE_DIRECTORY");
  const expected = {
    repository: requireEnvironment("REPOSITORY"),
    sourceCommit: requireEnvironment("SOURCE_COMMIT"),
    workflowRunId: requireEnvironment("WORKFLOW_RUN_ID"),
  };
  const manifest = await verifyReleaseBundle(directory, expected);
  const head = await readDetachedGitHead(process.cwd());
  assert(head === manifest.sourceCommit, "checked-out HEAD does not match the release manifest");
  assert(process.version.slice(1) === manifest.nodeVersion, "actual Node.js version does not match the release manifest");
  if (verifyTools) {
    const npmVersion = commandOutput("npm", ["--version"]);
    const vscePackage = await readBoundedJsonFile(path.resolve("node_modules/@vscode/vsce/package.json"), "installed VSCE package");
    assert(npmVersion === manifest.npmVersion, "actual npm version does not match the release manifest");
    assert(vscePackage.version === manifest.vsceVersion, "actual VSCE version does not match the release manifest");
  }
  return { directory, manifest };
}

export function runVscePublisher(assetPath, { environment = process.env, spawn = spawnSync } = {}) {
  assert(!environment.VSCE_PAT, "VSCE_PAT must not be present; Marketplace publication requires GitHub Actions OIDC");
  assert(typeof environment.ACTIONS_ID_TOKEN_REQUEST_URL === "string" && environment.ACTIONS_ID_TOKEN_REQUEST_URL.length > 0, "GitHub Actions OIDC request URL is required");
  assert(typeof environment.ACTIONS_ID_TOKEN_REQUEST_TOKEN === "string" && environment.ACTIONS_ID_TOKEN_REQUEST_TOKEN.length > 0, "GitHub Actions OIDC request token is required");
  const vsceBinary = path.resolve("node_modules/.bin/vsce");
  const allowedEnvironmentNames = [
    "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
    "ACTIONS_ID_TOKEN_REQUEST_URL",
    "CI",
    "GITHUB_ACTIONS",
    "GITHUB_API_URL",
    "GITHUB_REPOSITORY",
    "GITHUB_RUN_ATTEMPT",
    "GITHUB_RUN_ID",
    "HOME",
    "LANG",
    "LC_ALL",
    "NODE_OPTIONS",
    "PATH",
    "RUNNER_TEMP",
    "RUNNER_TOOL_CACHE",
    "TMPDIR",
  ];
  const publisherEnvironment = Object.fromEntries(
    allowedEnvironmentNames
      .filter((name) => typeof environment[name] === "string")
      .map((name) => [name, environment[name]]),
  );
  const result = spawn(vsceBinary, ["publish", "--packagePath", assetPath, "--oidc", "--no-dependencies"], {
    env: publisherEnvironment,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error(`VSCE publish failed with exit status ${result.status ?? "unknown"}; inspect the masked Actions step log`);
  }
}

async function main() {
  const command = process.argv[2];
  if (command === "prepare") {
    const workspace = process.cwd();
    const packageJson = await readBoundedJsonFile(path.join(workspace, "package.json"), "package.json");
    const vscePackage = await readBoundedJsonFile(path.join(workspace, "node_modules/@vscode/vsce/package.json"), "installed VSCE package");
    const manifest = await prepareReleaseBundle({
      workspace,
      releaseDirectory: requireEnvironment("RELEASE_DIRECTORY"),
      sourceVsix: requireEnvironment("SOURCE_VSIX"),
      repository: requireEnvironment("REPOSITORY"),
      sourceCommit: requireEnvironment("SOURCE_COMMIT"),
      workflowRunId: requireEnvironment("WORKFLOW_RUN_ID"),
      githubEventName: requireEnvironment("GITHUB_EVENT_NAME"),
      githubRef: requireEnvironment("GITHUB_REF"),
      expectedVersion: process.env.EXPECTED_VERSION ?? "",
      publish: process.env.PUBLISH ?? "false",
      nodeVersion: process.version.slice(1),
      npmVersion: commandOutput("npm", ["--version"]),
      vsceVersion: vscePackage.version,
      headCommit: await readDetachedGitHead(workspace),
      packageJson,
      outputPath: process.env.GITHUB_OUTPUT,
    });
    process.stdout.write(`Prepared ${manifest.assetFile} (${manifest.sha256}).\n`);
    return;
  }

  if (command === "verify-artifact") {
    const { manifest } = await loadBundleFromEnvironment();
    process.stdout.write(`Verified ${manifest.assetFile} (${manifest.sha256}).\n`);
    return;
  }

  if (command === "github-preflight") {
    const { directory, manifest } = await loadBundleFromEnvironment();
    const result = await preflightGithubRelease({ fetchImpl: fetch, token: requireEnvironment("GITHUB_TOKEN"), directory, manifest });
    process.stdout.write(`GitHub release preflight: ${result.state}.\n`);
    return;
  }

  if (command === "prepare-marketplace-attempt") {
    const { directory, manifest } = await loadBundleFromEnvironment({ verifyTools: true });
    const workflowRunAttempt = requireEnvironment("WORKFLOW_RUN_ATTEMPT");
    validateMarketplaceRunAttempt(workflowRunAttempt);
    await preflightMarketplaceRelease({
      fetchImpl: fetch,
      token: requireEnvironment("GITHUB_TOKEN"),
      directory,
      manifest,
    });
    const receipt = await prepareMarketplaceAttemptReceipt(
      requireEnvironment("MARKETPLACE_ATTEMPT_DIRECTORY"),
      manifest,
      workflowRunAttempt,
    );
    process.stdout.write(`Prepared immutable Marketplace publication receipt for ${receipt.extensionId} ${receipt.version}.\n`);
    return;
  }

  if (command === "publish-marketplace") {
    const { directory, manifest } = await loadBundleFromEnvironment({ verifyTools: true });
    const result = await publishMarketplaceRelease({
      fetchImpl: fetch,
      token: requireEnvironment("GITHUB_TOKEN"),
      directory,
      manifest,
      workflowRunAttempt: requireEnvironment("WORKFLOW_RUN_ATTEMPT"),
      runPublisher: runVscePublisher,
    });
    process.stdout.write(`Marketplace publication state: ${result.state}.\n`);
    return;
  }

  if (command === "verify-marketplace") {
    const { manifest } = await loadBundleFromEnvironment();
    await requireMarketplaceVersionVisible(fetch, manifest);
    process.stdout.write(`Marketplace version ${manifest.version} is visible.\n`);
    return;
  }

  if (command === "publish-github") {
    const { directory, manifest } = await loadBundleFromEnvironment();
    const release = await publishGithubRelease({ fetchImpl: fetch, token: requireEnvironment("GITHUB_TOKEN"), directory, manifest });
    process.stdout.write(`Published GitHub Release ${release.tag_name}.\n`);
    return;
  }

  fail("Usage: release-helper.mjs <prepare|verify-artifact|github-preflight|prepare-marketplace-attempt|publish-marketplace|verify-marketplace|publish-github>");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
