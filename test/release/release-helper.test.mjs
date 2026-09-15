import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import {
  MARKETPLACE_ATTEMPT_FILE,
  PINNED_NODE_VERSION,
  PINNED_VSCE_VERSION,
  githubRequest,
  prepareMarketplaceAttemptReceipt,
  prepareReleaseBundle,
  preflightGithubRelease,
  probeMarketplaceArtifact,
  publishGithubRelease,
  publishMarketplaceRelease,
  readDetachedGitHead,
  requireMarketplaceVersionVisible,
  releaseBody,
  runVscePublisher,
  responseBytes,
  validateMarketplaceRunAttempt,
  validatePublicationGuard,
  verifyReleaseBundle,
  waitForMarketplace,
} from "../../scripts/release-helper.mjs";

const SOURCE_COMMIT = "a".repeat(40);
const REPOSITORY = "matheustecchio/safe-code";
const RUN_ID = "12345";
const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function makeBundle() {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "safe-code-release-"));
  temporaryDirectories.push(workspace);
  const directory = path.join(workspace, "bundle");
  await mkdir(directory);
  const sourceVsix = path.join(directory, "unversioned.vsix");
  await writeFile(sourceVsix, Buffer.from("PK\u0003\u0004safe-code-vsix"));
  const packageJson = {
    name: "safe-code",
    publisher: "matheus-tecchio",
    version: "0.5.0",
    repository: { type: "git", url: "https://github.com/matheustecchio/safe-code.git" },
    devDependencies: { "@vscode/vsce": PINNED_VSCE_VERSION },
  };
  const manifest = await prepareReleaseBundle({
    workspace,
    releaseDirectory: directory,
    sourceVsix,
    repository: REPOSITORY,
    sourceCommit: SOURCE_COMMIT,
    workflowRunId: RUN_ID,
    githubEventName: "pull_request",
    githubRef: "refs/pull/27/merge",
    expectedVersion: "",
    publish: false,
    nodeVersion: PINNED_NODE_VERSION,
    npmVersion: "10.9.4",
    vsceVersion: PINNED_VSCE_VERSION,
    headCommit: SOURCE_COMMIT,
    packageJson,
  });
  return { workspace, directory, manifest };
}

test("publication guard supports dry runs and only permits an exact main workflow dispatch", () => {
  const base = { packageVersion: "0.5.0", expectedVersion: "", githubRef: "refs/pull/27/merge", githubEventName: "pull_request" };
  assert.equal(validatePublicationGuard({ ...base, publish: false }), false);
  assert.equal(validatePublicationGuard({ ...base, publish: "false" }), false);
  assert.equal(validatePublicationGuard({ ...base, publish: true, githubEventName: "workflow_dispatch", githubRef: "refs/heads/main", expectedVersion: "0.5.0" }), true);
  assert.throws(() => validatePublicationGuard({ ...base, publish: true, githubRef: "refs/heads/main", expectedVersion: "0.5.0" }), /workflow_dispatch/);
  assert.throws(() => validatePublicationGuard({ ...base, publish: true, githubEventName: "push", githubRef: "refs/heads/main", expectedVersion: "0.5.0" }), /workflow_dispatch/);
  assert.throws(() => validatePublicationGuard({ ...base, publish: true, githubEventName: "workflow_dispatch", expectedVersion: "0.5.0" }), /refs\/heads\/main/);
  assert.throws(() => validatePublicationGuard({ ...base, publish: true, githubEventName: "workflow_dispatch", githubRef: "refs/heads/main" }), /required/);
  assert.throws(() => validatePublicationGuard({ ...base, publish: true, githubEventName: "workflow_dispatch", githubRef: "refs/heads/main", expectedVersion: "not\na-version" }), /canonical/);
  assert.throws(() => validatePublicationGuard({ ...base, publish: true, githubEventName: "workflow_dispatch", githubRef: "refs/heads/main", expectedVersion: "0.5.1" }), /does not match package\.json/);
});

test("Marketplace publication is limited to the first workflow run attempt", () => {
  assert.equal(validateMarketplaceRunAttempt("1"), true);
  assert.throws(() => validateMarketplaceRunAttempt("2"), /only on the first workflow run attempt/);
  assert.throws(() => validateMarketplaceRunAttempt("01"), /invalid/);
  assert.throws(() => validateMarketplaceRunAttempt(""), /invalid/);
});

test("prepares a canonical, versioned, three-file release bundle", async () => {
  const { directory, manifest } = await makeBundle();
  assert.equal((await verifyReleaseBundle(directory, {
    repository: REPOSITORY,
    sourceCommit: SOURCE_COMMIT,
    workflowRunId: RUN_ID,
  })).sha256, manifest.sha256);
  const names = (await readdir(directory)).sort();
  assert.deepEqual(names, [manifest.assetFile, manifest.checksumFile, manifest.manifestFile].sort());
  assert.match(await readFile(path.join(directory, manifest.checksumFile), "utf8"), /^[0-9a-f]{64}  safe-code-0\.5\.0\.vsix\n$/);
});

test("pins an installed VSCE release that implements OIDC publishing", async () => {
  assert.equal(PINNED_VSCE_VERSION, "4.0.0");
  const installed = JSON.parse(await readFile(path.resolve("node_modules/@vscode/vsce/package.json"), "utf8"));
  assert.equal(installed.version, PINNED_VSCE_VERSION);
  const cliSource = await readFile(path.resolve("node_modules/@vscode/vsce/out/main.js"), "utf8");
  const oidcSource = await readFile(path.resolve("node_modules/@vscode/vsce/out/oidc.js"), "utf8");
  assert.match(cliSource, /Option\('--oidc', 'Use OpenID Connect trusted publishing for authentication'\)/);
  assert.match(oidcSource, /marketplace\.visualstudio\.com/);
  assert.match(oidcSource, /_apis\/gallery\/token/);
});

test("creates one exact immutable Marketplace publication-attempt receipt", async () => {
  const { workspace, manifest } = await makeBundle();
  const receiptDirectory = path.join(workspace, "marketplace-attempt");
  const receipt = await prepareMarketplaceAttemptReceipt(receiptDirectory, manifest, "1");
  assert.deepEqual(receipt, {
    schemaVersion: 1,
    kind: "marketplace-publication-attempt",
    repository: REPOSITORY,
    sourceCommit: SOURCE_COMMIT,
    workflowRunId: RUN_ID,
    workflowRunAttempt: "1",
    extensionId: "matheus-tecchio.safe-code",
    version: "0.5.0",
    assetFile: "safe-code-0.5.0.vsix",
    sha256: manifest.sha256,
  });
  assert.deepEqual(await readdir(receiptDirectory), [MARKETPLACE_ATTEMPT_FILE]);
  assert.deepEqual(
    JSON.parse(await readFile(path.join(receiptDirectory, MARKETPLACE_ATTEMPT_FILE), "utf8")),
    receipt,
  );
  await assert.rejects(prepareMarketplaceAttemptReceipt(receiptDirectory, manifest, "1"), /must contain exactly/);
});

test("attempt-two consumers accept an attempt-one bundle because recovery is anchored to run id", async () => {
  const { directory } = await makeBundle();
  await verifyReleaseBundle(directory, { workflowRunId: RUN_ID });
});

test("rejects mutated, missing, extra, malformed, and symlinked bundle content", async (t) => {
  await t.test("mutated VSIX", async () => {
    const { directory, manifest } = await makeBundle();
    await writeFile(path.join(directory, manifest.assetFile), "PKmutated");
    await assert.rejects(verifyReleaseBundle(directory), /size|checksum/);
  });
  await t.test("missing file", async () => {
    const { directory, manifest } = await makeBundle();
    await unlink(path.join(directory, manifest.checksumFile));
    await assert.rejects(verifyReleaseBundle(directory), /exactly/);
  });
  await t.test("extra or duplicate-named content", async () => {
    const { directory } = await makeBundle();
    await writeFile(path.join(directory, "release-manifest-copy.json"), "{}");
    await assert.rejects(verifyReleaseBundle(directory), /exactly/);
  });
  await t.test("malformed metadata", async () => {
    const { directory } = await makeBundle();
    await writeFile(path.join(directory, "release-manifest.json"), "{\"schemaVersion\":1}\n");
    await assert.rejects(verifyReleaseBundle(directory), /unexpected or missing fields/);
  });
  await t.test("symlink", async () => {
    const { directory, manifest } = await makeBundle();
    const target = path.join(directory, manifest.checksumFile);
    const contents = await readFile(target);
    await unlink(target);
    const symlinkTarget = path.join(path.dirname(directory), "checksum-target");
    await writeFile(symlinkTarget, contents);
    await symlink(symlinkTarget, target);
    await assert.rejects(verifyReleaseBundle(directory), /regular file/);
  });
});

test("reads only a detached full-SHA Git HEAD", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "safe-code-git-head-"));
  temporaryDirectories.push(workspace);
  await mkdir(path.join(workspace, ".git"));
  await writeFile(path.join(workspace, ".git", "HEAD"), `${SOURCE_COMMIT}\n`);
  assert.equal(await readDetachedGitHead(workspace), SOURCE_COMMIT);
  await writeFile(path.join(workspace, ".git", "HEAD"), "ref: refs/heads/main\n");
  await assert.rejects(readDetachedGitHead(workspace), /detached Git HEAD/);
});

test("OIDC publisher rejects PATs, passes fixed flags, and strips unrelated credentials", () => {
  assert.throws(() => runVscePublisher("artifact.vsix", { environment: { VSCE_PAT: "secret" } }), /must not be present/);
  assert.throws(() => runVscePublisher("artifact.vsix", { environment: {} }), /OIDC request URL/);
  let invocation;
  runVscePublisher("artifact.vsix", {
    environment: {
      PATH: "/usr/bin",
      ACTIONS_ID_TOKEN_REQUEST_URL: "https://example.invalid/oidc",
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "oidc-secret",
      GITHUB_TOKEN: "github-secret",
      GH_TOKEN: "gh-secret",
      UNRELATED_SECRET: "other-secret",
    },
    spawn(command, args, options) {
      invocation = { command, args, options };
      return { status: 0, stdout: "should not be echoed", stderr: "should not be echoed" };
    },
  });
  assert.deepEqual(invocation.args, ["publish", "--packagePath", "artifact.vsix", "--oidc", "--no-dependencies"]);
  assert.equal(invocation.options.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN, "oidc-secret");
  assert.equal(invocation.options.env.GITHUB_TOKEN, undefined);
  assert.equal(invocation.options.env.GH_TOKEN, undefined);
  assert.equal(invocation.options.env.UNRELATED_SECRET, undefined);
});

test("GitHub request treats only an explicitly allowed 404 as absence", async () => {
  const url = `https://api.github.com/repos/${REPOSITORY}/git/ref/tags/v0.5.0`;
  assert.equal(await githubRequest(async () => new Response(null, { status: 404 }), "token", url, { allowNotFound: true }), null);
  for (const status of [401, 403, 429, 500, 503]) {
    await assert.rejects(
      githubRequest(async () => new Response("{}", { status }), "token", url, { allowNotFound: true }),
      new RegExp(`HTTP ${status}`),
    );
  }
});

test("bounded response reader stops chunked bodies before unbounded buffering", async () => {
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array([1, 2, 3]));
      controller.enqueue(new Uint8Array([4, 5, 6]));
      controller.close();
    },
  });
  await assert.rejects(responseBytes(new Response(body), "test", 5), /too large/);
});

function jsonResponse(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", ...headers } });
}

function releaseFixture(manifest, overrides = {}) {
  return {
    id: 1,
    tag_name: manifest.tag,
    target_commitish: manifest.sourceCommit,
    name: `Safe Code ${manifest.version}`,
    body: releaseBody(manifest),
    draft: true,
    prerelease: false,
    assets: [],
    ...overrides,
  };
}

function githubServer(manifest, {
  release = null,
  tagExists = false,
  redirectAssets = false,
  throwAfterPatchOnce = false,
  storeUploadsAsStarter = false,
} = {}) {
  const requests = [];
  const bytesByAssetId = new Map();
  let currentRelease = release;
  let publishedTag = tagExists;
  let nextAssetId = 100;
  let shouldThrowAfterPatch = throwAfterPatchOnce;

  if (currentRelease) {
    for (const asset of currentRelease.assets) {
      nextAssetId = Math.max(nextAssetId, asset.id + 1);
      if (asset.bytes) {
        bytesByAssetId.set(asset.id, Buffer.from(asset.bytes));
        delete asset.bytes;
      }
    }
  }

  async function fetchImpl(rawUrl, options = {}) {
    const url = new URL(rawUrl);
    requests.push({ url: url.toString(), options });
    if (url.hostname.endsWith(".githubusercontent.com")) {
      const id = Number(url.pathname.slice(1));
      assert.equal(options.headers, undefined);
      return new Response(bytesByAssetId.get(id), { status: 200 });
    }
    if (url.pathname.endsWith(`/git/ref/tags/${manifest.tag}`)) {
      return publishedTag
        ? jsonResponse({ ref: `refs/tags/${manifest.tag}`, object: { type: "commit", sha: manifest.sourceCommit } })
        : new Response(null, { status: 404 });
    }
    if (url.pathname.endsWith("/releases") && options.method === "POST") {
      const payload = JSON.parse(options.body);
      currentRelease = releaseFixture(manifest, {
        tag_name: payload.tag_name,
        target_commitish: payload.target_commitish,
        name: payload.name,
        body: payload.body,
        draft: payload.draft,
        prerelease: payload.prerelease,
      });
      return jsonResponse(currentRelease, 201);
    }
    if (url.pathname.endsWith("/releases") && (!options.method || options.method === "GET")) {
      return jsonResponse(currentRelease ? [currentRelease] : []);
    }
    if (/\/releases\/assets\/\d+$/.test(url.pathname)) {
      const id = Number(url.pathname.split("/").pop());
      if (options.method === "DELETE") {
        currentRelease.assets = currentRelease.assets.filter((asset) => asset.id !== id);
        bytesByAssetId.delete(id);
        return new Response(null, { status: 204 });
      }
      assert.equal(options.headers.Accept, "application/octet-stream");
      if (redirectAssets) {
        return new Response(null, { status: 302, headers: { location: `https://release-assets.githubusercontent.com/${id}` } });
      }
      return new Response(bytesByAssetId.get(id), { status: 200 });
    }
    if (url.hostname === "uploads.github.com" && /\/releases\/1\/assets$/.test(url.pathname)) {
      const bytes = Buffer.from(options.body);
      const asset = {
        id: nextAssetId++,
        name: url.searchParams.get("name"),
        size: bytes.byteLength,
        state: "uploaded",
        digest: `sha256:${(await import("node:crypto")).createHash("sha256").update(bytes).digest("hex")}`,
      };
      bytesByAssetId.set(asset.id, bytes);
      currentRelease.assets.push(storeUploadsAsStarter ? { ...asset, state: "starter" } : asset);
      return jsonResponse(asset, 201);
    }
    if (url.pathname.endsWith("/releases/1") && options.method === "PATCH") {
      const payload = JSON.parse(options.body);
      assert.deepEqual(payload, { draft: false, make_latest: "true" });
      currentRelease = { ...currentRelease, draft: false };
      publishedTag = true;
      if (shouldThrowAfterPatch) {
        shouldThrowAfterPatch = false;
        throw new Error("simulated lost publication response");
      }
      return jsonResponse(currentRelease);
    }
    if (url.pathname.endsWith("/releases/1")) {
      return jsonResponse(currentRelease);
    }
    throw new Error(`Unexpected fake request: ${options.method ?? "GET"} ${url}`);
  }

  return { fetchImpl, requests, getRelease: () => currentRelease, bytesByAssetId };
}

async function localAsset(directory, name, id, overrides = {}) {
  const bytes = await readFile(path.join(directory, name));
  return { id, name, size: bytes.byteLength, state: "uploaded", bytes, ...overrides };
}

test("creates a draft, uploads exactly three assets, re-downloads them, then publishes latest", async () => {
  const { directory, manifest } = await makeBundle();
  const server = githubServer(manifest);
  const published = await publishGithubRelease({ fetchImpl: server.fetchImpl, token: "token", directory, manifest });
  assert.equal(published.draft, false);
  assert.deepEqual(server.getRelease().assets.map((asset) => asset.name).sort(), [manifest.assetFile, manifest.checksumFile, manifest.manifestFile].sort());
  assert.equal(server.requests.filter((request) => request.url.startsWith("https://uploads.github.com/")).length, 3);
  assert.equal(server.requests.filter((request) => request.options.method === "PATCH").length, 1);
});

test("follows an allowlisted cross-origin asset redirect without forwarding authorization", async () => {
  const { directory, manifest } = await makeBundle();
  const existing = await localAsset(directory, manifest.assetFile, 100);
  const server = githubServer(manifest, { release: releaseFixture(manifest, { assets: [existing] }), redirectAssets: true });
  await publishGithubRelease({ fetchImpl: server.fetchImpl, token: "token", directory, manifest });
  assert(server.requests.some((request) => request.url.startsWith("https://release-assets.githubusercontent.com/")));
});

test("resumes only a matching same-run draft and never overwrites existing assets", async () => {
  const { directory, manifest } = await makeBundle();
  const existing = await localAsset(directory, manifest.assetFile, 100);
  const server = githubServer(manifest, { release: releaseFixture(manifest, { assets: [existing] }) });
  await publishGithubRelease({ fetchImpl: server.fetchImpl, token: "token", directory, manifest });
  assert.equal(server.requests.filter((request) => request.url.startsWith("https://uploads.github.com/")).length, 2);
});

test("removes only an expected starter asset from a same-run draft before re-uploading it", async () => {
  const { directory, manifest } = await makeBundle();
  const starter = { id: 100, name: manifest.assetFile, size: 0, state: "starter" };
  const server = githubServer(manifest, { release: releaseFixture(manifest, { assets: [starter] }) });
  await publishGithubRelease({ fetchImpl: server.fetchImpl, token: "token", directory, manifest });
  assert.equal(server.requests.filter((request) => request.options.method === "DELETE").length, 1);
  assert.equal(server.requests.filter((request) => request.url.startsWith("https://uploads.github.com/")).length, 3);
});

test("refuses to publish a draft while any release asset is incomplete", async () => {
  const { directory, manifest } = await makeBundle();
  const server = githubServer(manifest, { storeUploadsAsStarter: true });
  await assert.rejects(
    publishGithubRelease({ fetchImpl: server.fetchImpl, token: "token", directory, manifest }),
    /incomplete asset/,
  );
  assert.equal(server.requests.filter((request) => request.options.method === "PATCH").length, 0);
});

test("recovers idempotently when publication succeeded but the PATCH response was lost", async () => {
  const { directory, manifest } = await makeBundle();
  const server = githubServer(manifest, { throwAfterPatchOnce: true });
  await assert.rejects(
    publishGithubRelease({ fetchImpl: server.fetchImpl, token: "token", directory, manifest }),
    /simulated lost publication response/,
  );
  const requestCount = server.requests.length;
  const recovered = await publishGithubRelease({ fetchImpl: server.fetchImpl, token: "token", directory, manifest });
  assert.equal(recovered.draft, false);
  const retryRequests = server.requests.slice(requestCount);
  assert.equal(retryRequests.filter((request) => ["POST", "PATCH"].includes(request.options.method)).length, 0);
  assert.equal(retryRequests.filter((request) => request.url.startsWith("https://uploads.github.com/")).length, 0);
});

test("fails closed before mutation for published tags, foreign drafts, and mismatched assets", async (t) => {
  await t.test("published tag", async () => {
    const { directory, manifest } = await makeBundle();
    const server = githubServer(manifest, { tagExists: true });
    await assert.rejects(preflightGithubRelease({ fetchImpl: server.fetchImpl, token: "token", directory, manifest }), /already exists/);
    assert.equal(server.requests.filter((request) => request.options.method === "POST").length, 0);
  });
  await t.test("foreign run draft", async () => {
    const { directory, manifest } = await makeBundle();
    const foreign = { ...manifest, workflowRunId: "999" };
    const server = githubServer(manifest, { release: releaseFixture(manifest, { body: releaseBody(foreign) }) });
    await assert.rejects(publishGithubRelease({ fetchImpl: server.fetchImpl, token: "token", directory, manifest }), /provenance/);
    assert.equal(server.requests.filter((request) => ["POST", "PATCH"].includes(request.options.method)).length, 0);
  });
  await t.test("stale target", async () => {
    const { directory, manifest } = await makeBundle();
    const server = githubServer(manifest, { release: releaseFixture(manifest, { target_commitish: "b".repeat(40) }) });
    await assert.rejects(publishGithubRelease({ fetchImpl: server.fetchImpl, token: "token", directory, manifest }), /different commit/);
  });
  await t.test("prerelease draft", async () => {
    const { directory, manifest } = await makeBundle();
    const server = githubServer(manifest, { release: releaseFixture(manifest, { prerelease: true }) });
    await assert.rejects(publishGithubRelease({ fetchImpl: server.fetchImpl, token: "token", directory, manifest }), /must not be a prerelease/);
    assert.equal(server.requests.filter((request) => ["POST", "PATCH", "DELETE"].includes(request.options.method)).length, 0);
  });
  await t.test("mismatched existing asset", async () => {
    const { directory, manifest } = await makeBundle();
    const existing = await localAsset(directory, manifest.assetFile, 100, { size: 1 });
    const server = githubServer(manifest, { release: releaseFixture(manifest, { assets: [existing] }) });
    await assert.rejects(publishGithubRelease({ fetchImpl: server.fetchImpl, token: "token", directory, manifest }), /wrong size/);
    assert.equal(server.requests.filter((request) => request.options.method === "PATCH").length, 0);
  });
});

test("Marketplace polling retries only 404, is bounded, and does not compare repackaged bytes", async () => {
  const { manifest } = await makeBundle();
  const marketplaceBytes = Buffer.from("PK\u0003\u0004marketplace-signed-different-bytes");
  let calls = 0;
  let clock = 0;
  const result = await waitForMarketplace({
    manifest,
    maximumWaitMs: 30,
    intervalMs: 10,
    now: () => clock,
    sleep: async (milliseconds) => { clock += milliseconds; },
    fetchImpl: async () => ++calls < 3 ? new Response(null, { status: 404 }) : new Response(marketplaceBytes, { status: 200 }),
  });
  assert.equal(result.state, "present");
  assert.equal(calls, 3);

  for (const status of [401, 403, 429, 500]) {
    await assert.rejects(
      probeMarketplaceArtifact(async () => new Response("failure", { status }), manifest),
      new RegExp(`HTTP ${status}`),
    );
  }
});

test("Marketplace redirects share one absolute request timeout budget", async () => {
  const { manifest } = await makeBundle();
  let clock = 0;
  let calls = 0;
  await assert.rejects(
    probeMarketplaceArtifact(async () => {
      calls += 1;
      clock += 30;
      return new Response(null, { status: 302, headers: { location: "https://cdn.vsassets.io/package" } });
    }, manifest, { timeoutMs: 20, now: () => clock }),
    /bounded timeout/,
  );
  assert.equal(calls, 1);
});

test("GitHub publication visibility gate probes once and fails before release mutation when absent", async () => {
  const { manifest } = await makeBundle();
  let calls = 0;
  await assert.rejects(
    requireMarketplaceVersionVisible(async () => {
      calls += 1;
      return new Response(null, { status: 404 });
    }, manifest),
    /rerun only the GitHub publication job later/,
  );
  assert.equal(calls, 1);
});

test("successful publish may finish pending on repeated 404, while pre-existing versions and nonzero publisher exits fail", async () => {
  const { directory, manifest } = await makeBundle();
  let clock = 0;
  let publisherCalls = 0;
  const absentFetch = async (rawUrl) => {
    const url = new URL(rawUrl);
    if (url.hostname === "api.github.com" && url.pathname.includes("/git/ref/")) return new Response(null, { status: 404 });
    if (url.hostname === "api.github.com") return jsonResponse([]);
    return new Response(null, { status: 404 });
  };
  await assert.rejects(publishMarketplaceRelease({
    fetchImpl: async () => { throw new Error("network must not be reached"); },
    token: "token",
    directory,
    manifest,
    workflowRunAttempt: "2",
    runPublisher: async () => { publisherCalls += 1; },
  }), /only on the first workflow run attempt/);
  assert.equal(publisherCalls, 0);

  const pending = await publishMarketplaceRelease({
    fetchImpl: absentFetch,
    token: "token",
    directory,
    manifest,
    workflowRunAttempt: "1",
    runPublisher: async () => { publisherCalls += 1; },
    waitOptions: {
      maximumWaitMs: 20,
      intervalMs: 10,
      now: () => clock,
      sleep: async (milliseconds) => { clock += milliseconds; },
    },
  });
  assert.equal(pending.state, "accepted-pending-propagation");
  assert.equal(publisherCalls, 1);

  const presentFetch = async (rawUrl) => {
    const url = new URL(rawUrl);
    if (url.hostname === "api.github.com" && url.pathname.includes("/git/ref/")) return new Response(null, { status: 404 });
    if (url.hostname === "api.github.com") return jsonResponse([]);
    return new Response(Buffer.from("PK\u0003\u0004signed"), { status: 200 });
  };
  await assert.rejects(publishMarketplaceRelease({
    fetchImpl: presentFetch,
    token: "token",
    directory,
    manifest,
    workflowRunAttempt: "1",
    runPublisher: async () => { publisherCalls += 1; },
  }), /already exists/);

  await assert.rejects(publishMarketplaceRelease({
    fetchImpl: absentFetch,
    token: "token",
    directory,
    manifest,
    workflowRunAttempt: "1",
    runPublisher: async () => { throw new Error("ambiguous publisher failure"); },
  }), /ambiguous publisher failure/);
});
