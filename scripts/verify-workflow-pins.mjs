#!/usr/bin/env node

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

export const APPROVED_ACTIONS = Object.freeze({
  "actions/checkout": Object.freeze({
    sha: "3d3c42e5aac5ba805825da76410c181273ba90b1",
    version: "v7.0.1",
  }),
  "actions/setup-node": Object.freeze({
    sha: "820762786026740c76f36085b0efc47a31fe5020",
    version: "v7.0.0",
  }),
  "actions/upload-artifact": Object.freeze({
    sha: "043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
    version: "v7.0.1",
  }),
  "actions/download-artifact": Object.freeze({
    sha: "3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c",
    version: "v8.0.1",
  }),
});

const CANONICAL_USES = /^\s*-?\s*uses:\s+([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)@([0-9a-f]{40})\s+#\s+(v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\s*$/;
const MERGE_TAG = "tag:yaml.org,2002:merge";

async function collectWorkflowFiles(directory, root = directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectWorkflowFiles(entryPath, root));
    } else if (entry.isFile() && /\.ya?ml$/i.test(entry.name)) {
      files.push({ absolutePath: entryPath, relativePath: path.relative(root, entryPath) });
    } else if (entry.isSymbolicLink() && /\.ya?ml$/i.test(entry.name)) {
      throw new Error(`Workflow file ${path.relative(root, entryPath)} must not be a symbolic link`);
    }
  }
  return files;
}

function parseWorkflow(source, relativePath) {
  const stack = [];
  let root;
  let hasAnchor = false;

  try {
    yaml.load(source, {
      filename: relativePath,
      maxDepth: 100,
      maxTotalMergeKeys: 0,
      listener(event, state) {
        if (event === "open") {
          stack.push({ start: state.position, children: [] });
          return;
        }

        const node = stack.pop();
        if (!node) {
          throw new Error("unbalanced YAML parser events");
        }
        node.end = state.position;
        node.kind = state.kind;
        node.value = state.result;
        node.anchor = state.anchor;
        node.tag = state.tag;
        hasAnchor ||= typeof state.anchor === "string" && state.anchor.length > 0;
        if (stack.length > 0) {
          stack.at(-1).children.push(node);
        } else {
          root = node;
        }
      },
    });
  } catch {
    throw new Error(`${relativePath}: workflow YAML is invalid or uses an unsupported merge`);
  }

  if (stack.length !== 0 || !root) {
    throw new Error(`${relativePath}: workflow YAML did not produce one complete document`);
  }
  if (hasAnchor) {
    throw new Error(`${relativePath}: YAML anchors and aliases are forbidden in workflows`);
  }
  return root;
}

function lineIndexAt(source, position) {
  let line = 0;
  for (let index = 0; index < position; index += 1) {
    if (source.charCodeAt(index) === 10) {
      line += 1;
    }
  }
  return line;
}

function collectSemanticUses(node, source, usesEntries) {
  if (node.tag === MERGE_TAG) {
    throw new Error("YAML merge keys are forbidden in workflows");
  }
  if (node.kind === "scalar" && typeof node.value === "string" && node.value.includes("@latest")) {
    throw new Error("@latest is forbidden in decoded workflow values");
  }

  if (node.kind === "mapping") {
    if (node.children.length % 2 !== 0) {
      throw new Error("workflow mapping is structurally ambiguous");
    }
    for (let index = 0; index < node.children.length; index += 2) {
      const keyNode = node.children[index];
      const valueNode = node.children[index + 1];
      if (keyNode.value === "uses") {
        if (valueNode.kind !== "scalar" || typeof valueNode.value !== "string") {
          throw new Error("every semantic uses value must be a scalar string");
        }
        usesEntries.push({
          lineIndex: lineIndexAt(source, keyNode.start),
          value: valueNode.value,
        });
      }
      collectSemanticUses(keyNode, source, usesEntries);
      collectSemanticUses(valueNode, source, usesEntries);
    }
    return;
  }

  for (const child of node.children) {
    collectSemanticUses(child, source, usesEntries);
  }
}

function verifyWorkflowSource(source, relativePath) {
  if (source.includes("@latest")) {
    throw new Error(`${relativePath}: @latest is forbidden everywhere in workflow YAML`);
  }

  const root = parseWorkflow(source, relativePath);
  const semanticUses = [];
  collectSemanticUses(root, source, semanticUses);

  const lines = source.split(/\r?\n/);
  const canonicalByLine = new Map();
  lines.forEach((line, lineIndex) => {
    const match = line.match(CANONICAL_USES);
    if (!match) {
      return;
    }
    const [, action, sha, version] = match;
    const approved = APPROVED_ACTIONS[action];
    if (!approved) {
      throw new Error(`${relativePath}:${lineIndex + 1}: action ${action} has not been reviewed and approved`);
    }
    if (sha !== approved.sha || version !== approved.version) {
      throw new Error(`${relativePath}:${lineIndex + 1}: ${action} does not use its reviewed SHA and version comment`);
    }
    canonicalByLine.set(lineIndex, `${action}@${sha}`);
  });

  if (semanticUses.length !== canonicalByLine.size) {
    throw new Error(`${relativePath}: every semantic uses key must have exactly one canonical source line`);
  }

  const usedLines = new Set();
  for (const entry of semanticUses) {
    const canonicalValue = canonicalByLine.get(entry.lineIndex);
    if (canonicalValue === undefined || canonicalValue !== entry.value || usedLines.has(entry.lineIndex)) {
      throw new Error(`${relativePath}:${entry.lineIndex + 1}: semantic uses key is not written in the required canonical form`);
    }
    usedLines.add(entry.lineIndex);
  }

  if (usedLines.size !== canonicalByLine.size) {
    throw new Error(`${relativePath}: canonical-looking uses text does not map one-to-one to semantic YAML keys`);
  }
}

export async function verifyWorkflowPins(workflowsDirectory) {
  const workflowFiles = await collectWorkflowFiles(workflowsDirectory);
  if (workflowFiles.length === 0) {
    throw new Error(`No workflow files found in ${workflowsDirectory}`);
  }

  const failures = [];
  for (const file of workflowFiles) {
    try {
      verifyWorkflowSource(await readFile(file.absolutePath, "utf8"), file.relativePath);
    } catch (error) {
      failures.push(error instanceof Error ? error.message : `${file.relativePath}: workflow verification failed`);
    }
  }

  if (failures.length > 0) {
    throw new Error(`Workflow action pin verification failed:\n${failures.join("\n")}`);
  }
  return workflowFiles.map((file) => file.relativePath);
}

async function main() {
  const workflowsDirectory = process.argv[2] ?? path.resolve(".github/workflows");
  const files = await verifyWorkflowPins(workflowsDirectory);
  process.stdout.write(`Verified reviewed immutable action pins in ${files.length} workflow file(s).\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
