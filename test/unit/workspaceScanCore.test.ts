import * as assert from "assert";
import {
  BoundedScanQueue,
  getDiscoveryMaxResults,
  getStaleDiagnosticKeys,
  isPositiveInteger,
  MAX_PENDING_SCANS,
  shouldCleanupStaleDiagnostics,
  utf8ByteLength,
  WorkspaceScanBudget
} from "../../src/workspaceScanCore";
import { workspaceScanStressEvents } from "../fixtures/workspaceScanStress";

suite("workspace scan core", () => {
  test("coalesces a URI and preserves the latest queued value", () => {
    const queue = new BoundedScanQueue<number>(2);

    assert.strictEqual(queue.enqueue("file:///one.ts", 1), "queued");
    assert.strictEqual(queue.enqueue("file:///one.ts", 2), "coalesced");
    assert.strictEqual(queue.size, 1);
    const queued = queue.shift();
    assert.ok(queued);
    assert.strictEqual(queued.key, "file:///one.ts");
    assert.strictEqual(queued.value, 2);
    assert.strictEqual(queue.isCurrent(queued.key, queued.version), true);
    queue.release(queued.key, queued.version);
    assert.strictEqual(queue.trackedSize, 0);
    assert.strictEqual(queue.shift(), undefined);
  });

  test("bounds unique work and reports overflow only once", () => {
    const queue = new BoundedScanQueue<number>();
    let overflowedEvents = 0;

    for (const event of workspaceScanStressEvents) {
      if (queue.enqueue(event.key, event.value) === "overflow") {
        overflowedEvents += 1;
      }
    }

    assert.strictEqual(queue.size, MAX_PENDING_SCANS);
    assert.strictEqual(queue.trackedSize, MAX_PENDING_SCANS);
    assert.strictEqual(overflowedEvents, workspaceScanStressEvents.length - MAX_PENDING_SCANS);
    for (const expected of workspaceScanStressEvents.slice(0, MAX_PENDING_SCANS)) {
      const queued = queue.shift();
      assert.ok(queued);
      assert.strictEqual(queued.key, expected.key);
      assert.strictEqual(queued.value, expected.value);
      queue.release(queued.key, queued.version);
    }
    assert.strictEqual(queue.shift(), undefined);
    assert.strictEqual(queue.trackedSize, 0);
    assert.strictEqual(queue.consumeOverflow(), true);
    assert.strictEqual(queue.consumeOverflow(), false);
  });

  test("coalesces an existing URI when the queue is already full", () => {
    const queue = new BoundedScanQueue<number>();
    for (let index = 0; index < MAX_PENDING_SCANS; index += 1) {
      assert.strictEqual(queue.enqueue(`file:///${index}.ts`, index), "queued");
    }

    assert.strictEqual(queue.enqueue("file:///0.ts", 999), "coalesced");
    assert.strictEqual(queue.size, MAX_PENDING_SCANS);
    const queued = queue.shift();
    assert.ok(queued);
    assert.strictEqual(queued.key, "file:///0.ts");
    assert.strictEqual(queued.value, 999);
    assert.strictEqual(queue.consumeOverflow(), false);
  });

  test("latches two distinct overflow episodes", () => {
    const queue = new BoundedScanQueue<number>(1);

    queue.enqueue("file:///first.ts", 1);
    queue.enqueue("file:///first-overflow.ts", 2);
    assert.strictEqual(queue.consumeOverflow(), true);
    assert.strictEqual(queue.consumeOverflow(), false);

    queue.clear();
    queue.enqueue("file:///second.ts", 3);
    queue.enqueue("file:///second-overflow.ts", 4);
    assert.strictEqual(queue.consumeOverflow(), true);
    assert.strictEqual(queue.consumeOverflow(), false);
  });

  test("keeps overflow recovery latched after every retained item is removed", () => {
    const queue = new BoundedScanQueue<number>(2);
    queue.enqueue("file:///one.ts", 1);
    queue.enqueue("file:///two.ts", 2);
    queue.enqueue("file:///dropped.ts", 3);

    queue.remove("file:///one.ts");
    queue.remove("file:///two.ts");

    assert.strictEqual(queue.size, 0);
    assert.strictEqual(queue.trackedSize, 0);
    assert.strictEqual(queue.consumeOverflow(), true);
    assert.strictEqual(queue.consumeOverflow(), false);
  });

  test("invalidates only active URI guards and releases them after work", () => {
    const queue = new BoundedScanQueue<number>(2);
    queue.enqueue("file:///active.ts", 1);
    const active = queue.shift();
    assert.ok(active);
    assert.strictEqual(queue.isCurrent(active.key, active.version), true);

    queue.remove(active.key);
    assert.strictEqual(queue.isCurrent(active.key, active.version), false);
    assert.strictEqual(queue.trackedSize, 0);

    const fullScanVersion = queue.begin("file:///workspace.ts");
    assert.strictEqual(queue.trackedSize, 1);
    queue.release("file:///workspace.ts", fullScanVersion);
    assert.strictEqual(queue.trackedSize, 0);
  });

  test("accepts exact file and workspace budget limits", () => {
    const budget = new WorkspaceScanBudget({
      maxFileSizeBytes: 8,
      maxWorkspaceScanFiles: 2,
      maxWorkspaceScanBytes: 16
    });

    assert.strictEqual(budget.accept(8), "accepted");
    assert.strictEqual(budget.accept(8), "accepted");
    assert.strictEqual(budget.accept(0), "file-budget-exhausted");
    assert.strictEqual(budget.acceptedFiles, 2);
    assert.strictEqual(budget.acceptedBytes, 16);
    assert.strictEqual(budget.check(9), "oversized");
    assert.strictEqual(budget.acceptedFiles, 2);
    assert.strictEqual(budget.acceptedBytes, 16);
  });

  test("distinguishes oversized files from exhausted aggregate bytes", () => {
    const budget = new WorkspaceScanBudget({
      maxFileSizeBytes: 10,
      maxWorkspaceScanFiles: 10,
      maxWorkspaceScanBytes: 12
    });

    assert.strictEqual(budget.check(11), "oversized");
    assert.strictEqual(budget.accept(8), "accepted");
    assert.strictEqual(budget.check(5), "byte-budget-exhausted");
    assert.strictEqual(budget.acceptedFiles, 1);
    assert.strictEqual(budget.acceptedBytes, 8);
  });

  test("uses UTF-8 bytes and validates positive integer settings", () => {
    assert.strictEqual(utf8ByteLength("safe"), 4);
    assert.strictEqual(utf8ByteLength("aé🙂"), 7);
    assert.strictEqual(isPositiveInteger(1), true);
    assert.strictEqual(isPositiveInteger(1.5), false);
    assert.strictEqual(isPositiveInteger(0), false);
    assert.strictEqual(isPositiveInteger(Number.POSITIVE_INFINITY), false);
    assert.strictEqual(getDiscoveryMaxResults(10_000), 10_001);
    assert.strictEqual(getDiscoveryMaxResults(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER);
  });

  test("only cleans globally after a complete scan", () => {
    assert.strictEqual(shouldCleanupStaleDiagnostics(false, false), true);
    assert.strictEqual(shouldCleanupStaleDiagnostics(true, false), false);
    assert.strictEqual(shouldCleanupStaleDiagnostics(false, true), false);
    assert.strictEqual(shouldCleanupStaleDiagnostics(true, true), false);

    const previous = ["file:///processed.ts", "file:///unvisited.ts"];
    const current = new Set(["file:///processed.ts"]);
    assert.deepStrictEqual(getStaleDiagnosticKeys(previous, current, true, false), []);
    assert.deepStrictEqual(getStaleDiagnosticKeys(previous, current, false, true), []);
    assert.deepStrictEqual(getStaleDiagnosticKeys(previous, current, false, false), ["file:///unvisited.ts"]);
  });

  test("handles ten thousand queued events inside a broad resource envelope", () => {
    const startedAt = process.hrtime.bigint();
    const startingHeap = process.memoryUsage().heapUsed;
    const queue = new BoundedScanQueue<number>();

    for (const event of workspaceScanStressEvents) {
      queue.enqueue(event.key, event.value);
    }

    const elapsedMilliseconds = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    const heapGrowthBytes = process.memoryUsage().heapUsed - startingHeap;

    assert.strictEqual(queue.size, MAX_PENDING_SCANS);
    assert.strictEqual(queue.trackedSize, MAX_PENDING_SCANS);
    assert.strictEqual(queue.consumeOverflow(), true);
    assert.ok(elapsedMilliseconds < 10_000, `Queue stress run took ${elapsedMilliseconds.toFixed(1)}ms`);
    assert.ok(heapGrowthBytes < 128 * 1024 * 1024, `Queue stress run grew the heap by ${heapGrowthBytes} bytes`);
  });
});
