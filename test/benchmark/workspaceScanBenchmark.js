"use strict";

const assert = require("node:assert/strict");
const {
  BoundedScanQueue,
  DEFAULT_MAX_FILE_SIZE_BYTES,
  DEFAULT_MAX_WORKSPACE_SCAN_BYTES,
  DEFAULT_MAX_WORKSPACE_SCAN_FILES,
  MAX_PENDING_SCANS,
  WorkspaceScanBudget
} = require("../../.test-out/src/workspaceScanCore.js");
const {
  defaultIgnoredPaths,
  scanText,
  shouldScanFile
} = require("../../.test-out/src/scannerCore.js");
const {
  workspaceScanStressEligibleFileCount,
  workspaceScanStressEventCount,
  workspaceScanStressEvents,
  workspaceScanStressFindingCount
} = require("../../.test-out/test/fixtures/workspaceScanStress.js");

const maximumElapsedMilliseconds = 10_000;
const maximumHeapGrowthBytes = 128 * 1024 * 1024;

function exerciseWorkspaceScanCore(events) {
  const queue = new BoundedScanQueue();
  const budget = new WorkspaceScanBudget({
    maxFileSizeBytes: DEFAULT_MAX_FILE_SIZE_BYTES,
    maxWorkspaceScanFiles: DEFAULT_MAX_WORKSPACE_SCAN_FILES,
    maxWorkspaceScanBytes: DEFAULT_MAX_WORKSPACE_SCAN_BYTES
  });
  let findings = 0;
  let overflowedEvents = 0;
  let queuePeak = 0;

  for (const event of events) {
    if (queue.enqueue(event.key, event.value) === "overflow") {
      overflowedEvents += 1;
    }
    queuePeak = Math.max(queuePeak, queue.size);

    if (!shouldScanFile(event.fileName, event.relativePath, defaultIgnoredPaths)) {
      continue;
    }

    const byteLength = Buffer.byteLength(event.text, "utf8");
    assert.equal(budget.accept(byteLength), "accepted");
    findings += scanText(event.text, { minimumSecretLength: 8 }).length;
  }

  return {
    acceptedFiles: budget.acceptedFiles,
    findings,
    overflowed: queue.consumeOverflow(),
    overflowedEvents,
    queuePeak,
    queueSize: queue.size,
    trackedSize: queue.trackedSize,
    scannedBytes: budget.acceptedBytes
  };
}

exerciseWorkspaceScanCore(workspaceScanStressEvents.slice(0, 100));
if (global.gc) {
  global.gc();
}

const startingHeapBytes = process.memoryUsage().heapUsed;
const startedAt = process.hrtime.bigint();
const result = exerciseWorkspaceScanCore(workspaceScanStressEvents);
const elapsedMilliseconds = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
const heapGrowthBytes = Math.max(0, process.memoryUsage().heapUsed - startingHeapBytes);

assert.equal(result.queueSize, MAX_PENDING_SCANS);
assert.equal(result.trackedSize, MAX_PENDING_SCANS);
assert.equal(result.overflowedEvents, workspaceScanStressEventCount - MAX_PENDING_SCANS);
assert.equal(result.overflowed, true);
assert.equal(result.queuePeak, MAX_PENDING_SCANS);
assert.equal(result.acceptedFiles, workspaceScanStressEligibleFileCount);
assert.equal(result.findings, workspaceScanStressFindingCount);
assert.ok(elapsedMilliseconds < maximumElapsedMilliseconds, `elapsed ${elapsedMilliseconds.toFixed(1)}ms`);
assert.ok(heapGrowthBytes < maximumHeapGrowthBytes, `heap growth ${heapGrowthBytes} bytes`);

process.stdout.write(
  `${JSON.stringify({
    events: workspaceScanStressEventCount,
    queueLimit: MAX_PENDING_SCANS,
    queuePeak: result.queuePeak,
    overflowedEvents: result.overflowedEvents,
    acceptedFiles: result.acceptedFiles,
    scannedBytes: result.scannedBytes,
    findings: result.findings,
    elapsedMilliseconds: Number(elapsedMilliseconds.toFixed(1)),
    heapGrowthBytes,
    maxFileSizeBytes: DEFAULT_MAX_FILE_SIZE_BYTES,
    maxWorkspaceScanFiles: DEFAULT_MAX_WORKSPACE_SCAN_FILES,
    maxWorkspaceScanBytes: DEFAULT_MAX_WORKSPACE_SCAN_BYTES
  })}\n`
);
