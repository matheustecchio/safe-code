import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import { APPROVED_ACTIONS, verifyWorkflowPins } from "../../scripts/verify-workflow-pins.mjs";

const EXPECTED_APPROVED_ACTIONS = {
  "actions/checkout": { sha: "3d3c42e5aac5ba805825da76410c181273ba90b1", version: "v7.0.1" },
  "actions/setup-node": { sha: "820762786026740c76f36085b0efc47a31fe5020", version: "v7.0.0" },
  "actions/upload-artifact": { sha: "043fb46d1a93c77aae656e7c1c64a875d1fc6a0a", version: "v7.0.1" },
  "actions/download-artifact": { sha: "3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c", version: "v8.0.1" },
};

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function workflowDirectory(files) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "safe-code-workflows-"));
  temporaryDirectories.push(directory);
  for (const [fileName, contents] of Object.entries(files)) {
    const filePath = path.join(directory, fileName);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, contents);
  }
  return directory;
}

function approved(action) {
  const pin = APPROVED_ACTIONS[action];
  return `uses: ${action}@${pin.sha} # ${pin.version}`;
}

test("exports exactly the independently reviewed action allowlist", () => {
  assert.deepEqual(APPROVED_ACTIONS, EXPECTED_APPROVED_ACTIONS);
});

test("verifies the repository's actual workflow tree", async () => {
  assert.deepEqual(await verifyWorkflowPins(path.resolve(".github/workflows")), ["ci.yml", "publish-github-release.yml"]);
});

test("accepts reviewed pins in both .yml and nested .yaml workflows", async () => {
  const directory = await workflowDirectory({
    "ci.yml": `steps:\n  - ${approved("actions/checkout")}\n  - ${approved("actions/setup-node")}\n`,
    "nested/release.yaml": `jobs:\n  reusable:\n    ${approved("actions/upload-artifact")}\n  download:\n    ${approved("actions/download-artifact")}\n`,
  });

  assert.deepEqual(await verifyWorkflowPins(directory), ["ci.yml", path.join("nested", "release.yaml")]);
});

test("ignores comments and ordinary run strings that mention uses", async () => {
  const directory = await workflowDirectory({
    "ci.yml": `# uses: actions/checkout@v7\nsteps:\n  - run: 'echo "uses: documentation only"'\n  - ${approved("actions/checkout")}\n`,
  });
  await verifyWorkflowPins(directory);
});

test("accepts canonical pins at both step and reusable-job indentation levels", async () => {
  const directory = await workflowDirectory({
    "ci.yml": `jobs:\n  build:\n    steps:\n      - ${approved("actions/checkout")}\n  upload:\n    ${approved("actions/upload-artifact")}\n`,
  });
  await verifyWorkflowPins(directory);
});

const rejected = {
  "quoted mutable ref": `steps:\n  - uses: "actions/checkout@v7"\n`,
  "quoted key": `steps:\n  - "uses": actions/checkout@v7\n`,
  "escaped semantic key": `steps:\n  - "u\\x73es": actions/checkout@${APPROVED_ACTIONS["actions/checkout"].sha}\n`,
  "escaped canonical-looking value": `steps:\n  - uses: "actions/check\\x6fut@${APPROVED_ACTIONS["actions/checkout"].sha}" # v7.0.1\n`,
  "explicit semantic key": `jobs:\n  call:\n    ? uses\n    : actions/checkout@${APPROVED_ACTIONS["actions/checkout"].sha}\n`,
  "folded value": `steps:\n  - uses: >\n      actions/checkout@v7\n`,
  "block value": `steps:\n  - uses: |\n      actions/checkout@v7\n`,
  "matrix value": `steps:\n  - uses: \${{ matrix.action }}\n`,
  "missing SHA": `steps:\n  - uses: actions/checkout\n`,
  "short SHA": `steps:\n  - uses: actions/checkout@3d3c42e # v7.0.1\n`,
  "uppercase SHA": `steps:\n  - uses: actions/checkout@3D3C42E5AAC5BA805825DA76410C181273BA90B1 # v7.0.1\n`,
  "branch ref": `steps:\n  - uses: actions/checkout@main # v7.0.1\n`,
  "latest ref": `steps:\n  - uses: actions/checkout@latest # v7.0.1\n`,
  "wrong full SHA": `steps:\n  - uses: actions/checkout@${"a".repeat(40)} # v7.0.1\n`,
  "wrong version comment": `steps:\n  - uses: actions/checkout@${APPROVED_ACTIONS["actions/checkout"].sha} # v7.0.0\n`,
  "unknown remote action": `steps:\n  - uses: example/action@${"a".repeat(40)} # v1.2.3\n`,
  "local action": `steps:\n  - uses: ./local-action\n`,
  "inline mapping": `steps:\n  - { uses: actions/checkout@${APPROVED_ACTIONS["actions/checkout"].sha} }\n`,
  "later inline mapping field": `steps:\n  - { name: Checkout, uses: actions/checkout@main }\n`,
  "keyed nested flow mapping": `steps:\n  - wrapper: { nested: { uses: actions/checkout@${APPROVED_ACTIONS["actions/checkout"].sha} } }\n`,
  "reusable mutable workflow": `jobs:\n  call:\n    uses: owner/repository/.github/workflows/build.yml@main\n`,
  "latest in run command": `steps:\n  - run: npx package@latest\n`,
  "escaped latest in run command": `steps:\n  - run: "npx package@lat\\u0065st"\n`,
  "latest in comment": `# dependency@latest\nsteps:\n  - ${approved("actions/checkout")}\n`,
  "alias value": `pin: &pin actions/checkout@${APPROVED_ACTIONS["actions/checkout"].sha}\nsteps:\n  - uses: *pin\n`,
  "unrelated anchor": `metadata: &metadata safe\nsteps:\n  - ${approved("actions/checkout")}\n`,
  "merge key": `base: &base\n  ${approved("actions/checkout")}\nsteps:\n  - <<: *base\n`,
  "empty merge key": `steps:\n  - <<: {}\n    ${approved("actions/checkout")}\n`,
  "canonical text smuggling": `steps:\n  - run: |\n      ${approved("actions/checkout")}\n  - "u\\x73es": actions/checkout@${APPROVED_ACTIONS["actions/checkout"].sha}\n`,
  "malformed YAML": `steps: [\n`,
  "multiple YAML documents": `steps: []\n---\nsteps: []\n`,
};

for (const [name, contents] of Object.entries(rejected)) {
  test(`rejects ${name}`, async () => {
    const directory = await workflowDirectory({ "bad.yml": contents });
    await assert.rejects(verifyWorkflowPins(directory), /Workflow action pin verification failed/);
  });
}
