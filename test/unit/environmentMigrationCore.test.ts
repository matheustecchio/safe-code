import * as assert from "assert";
import {
  AppliedEnvironmentMigrationError,
  EnvironmentMigrationCancellation,
  EnvironmentMigrationCoordinator,
  EnvironmentMigrationError,
  EnvironmentMigrationErrorCode,
  EnvironmentMigrationMutation,
  EnvironmentMigrationStep,
  EnvironmentMigrationTransaction,
  getEnvironmentMigrationMessage,
  normalizeEnvironmentMigrationError
} from "../../src/environmentMigrationCore";

const migrationSteps = ["gitignore", "example", "environment", "source"] as const;

suite("environment migration core", () => {
  test("runs preparation, mutations, and verification in the required order", async () => {
    const cancellation = new MutableCancellation();
    const harness = createHarness(cancellation);

    await new EnvironmentMigrationCoordinator().run("workspace", harness.transaction, cancellation);

    assert.deepStrictEqual(harness.events, [
      "prepare",
      "before:gitignore",
      "apply:gitignore",
      "before:example",
      "apply:example",
      "before:environment",
      "apply:environment",
      "before:source",
      "apply:source",
      "verify"
    ]);
    assert.deepStrictEqual([...harness.applied], migrationSteps);
  });

  test("cancels before preparation without starting or rolling back work", async () => {
    const cancellation = new MutableCancellation(true);
    const harness = createHarness(cancellation);

    await expectMigrationError(
      new EnvironmentMigrationCoordinator().run("workspace", harness.transaction, cancellation),
      "cancelled"
    );

    assert.deepStrictEqual(harness.events, []);
    assert.deepStrictEqual([...harness.applied], []);
  });

  test("cancels after preparation without starting or rolling back mutations", async () => {
    const cancellation = new MutableCancellation();
    const harness = createHarness(cancellation, { cancelAfterPrepare: true });

    await expectMigrationError(
      new EnvironmentMigrationCoordinator().run("workspace", harness.transaction, cancellation),
      "cancelled"
    );

    assert.deepStrictEqual(harness.events, ["prepare"]);
    assert.deepStrictEqual([...harness.applied], []);
  });

  for (const step of migrationSteps) {
    test(`cancels before the ${step} mutation and rolls back completed mutations`, async () => {
      const cancellation = new MutableCancellation();
      const harness = createHarness(cancellation, { cancelBeforeStep: step });
      const completedSteps = migrationSteps.slice(0, migrationSteps.indexOf(step));

      await expectMigrationError(
        new EnvironmentMigrationCoordinator().run("workspace", harness.transaction, cancellation),
        "cancelled"
      );

      assert.deepStrictEqual(harness.rollbackCalls, [...completedSteps].reverse());
      assert.deepStrictEqual([...harness.applied], []);
      assert.strictEqual(harness.events.includes(`apply:${step}`), false);
    });

    test(`cancels after the ${step} mutation and rolls it back too`, async () => {
      const cancellation = new MutableCancellation();
      const harness = createHarness(cancellation, { cancelAfterStep: step });
      const completedSteps = migrationSteps.slice(0, migrationSteps.indexOf(step) + 1);

      await expectMigrationError(
        new EnvironmentMigrationCoordinator().run("workspace", harness.transaction, cancellation),
        "cancelled"
      );

      assert.deepStrictEqual(harness.rollbackCalls, [...completedSteps].reverse());
      assert.deepStrictEqual([...harness.applied], []);
    });
  }

  test("cancels after final verification and rolls back every mutation", async () => {
    const cancellation = new MutableCancellation();
    const harness = createHarness(cancellation, { cancelAfterVerify: true });

    await expectMigrationError(
      new EnvironmentMigrationCoordinator().run("workspace", harness.transaction, cancellation),
      "cancelled"
    );

    assert.deepStrictEqual(harness.rollbackCalls, [...migrationSteps].reverse());
    assert.deepStrictEqual([...harness.applied], []);
  });

  for (const step of migrationSteps) {
    test(`rolls back prior mutations when ${step} fails before mutating`, async () => {
      const cancellation = new MutableCancellation();
      const failureCode = getFailureCode(step);
      const harness = createHarness(cancellation, {
        failBeforeMutation: step,
        mutationFailure: new EnvironmentMigrationError(failureCode)
      });
      const completedSteps = migrationSteps.slice(0, migrationSteps.indexOf(step));

      await expectMigrationError(
        new EnvironmentMigrationCoordinator().run("workspace", harness.transaction, cancellation),
        failureCode
      );

      assert.deepStrictEqual(harness.rollbackCalls, [...completedSteps].reverse());
      assert.deepStrictEqual([...harness.applied], []);
    });

    test(`journals and rolls back ${step} when it fails after mutating`, async () => {
      const cancellation = new MutableCancellation();
      const failureCode = getFailureCode(step);
      const harness = createHarness(cancellation, {
        failAfterMutation: step,
        mutationFailure: new EnvironmentMigrationError(failureCode)
      });
      const completedSteps = migrationSteps.slice(0, migrationSteps.indexOf(step) + 1);

      await expectMigrationError(
        new EnvironmentMigrationCoordinator().run("workspace", harness.transaction, cancellation),
        failureCode
      );

      assert.deepStrictEqual(harness.rollbackCalls, [...completedSteps].reverse());
      assert.deepStrictEqual([...harness.applied], []);
    });
  }

  test("rolls back every mutation in exact reverse order after verification fails", async () => {
    const cancellation = new MutableCancellation();
    const harness = createHarness(cancellation, {
      verifyFailure: new EnvironmentMigrationError("concurrent-change")
    });

    await expectMigrationError(
      new EnvironmentMigrationCoordinator().run("workspace", harness.transaction, cancellation),
      "concurrent-change"
    );

    assert.deepStrictEqual(harness.rollbackCalls, ["source", "environment", "example", "gitignore"]);
    assert.deepStrictEqual([...harness.applied], []);
  });

  test("retains the environment secret and its Git protection when source rollback fails", async () => {
    const cancellation = new MutableCancellation();
    const harness = createHarness(cancellation, {
      rollbackFailures: new Set<EnvironmentMigrationStep>(["source"]),
      verifyFailure: new EnvironmentMigrationError("concurrent-change")
    });

    await expectMigrationError(
      new EnvironmentMigrationCoordinator().run("workspace", harness.transaction, cancellation),
      "rollback-failed"
    );

    assert.deepStrictEqual(harness.rollbackCalls, ["source", "example"]);
    assert.deepStrictEqual([...harness.applied], ["gitignore", "environment", "source"]);
  });

  test("retains Git protection when environment rollback fails", async () => {
    const cancellation = new MutableCancellation();
    const harness = createHarness(cancellation, {
      rollbackFailures: new Set<EnvironmentMigrationStep>(["environment"]),
      verifyFailure: new EnvironmentMigrationError("concurrent-change")
    });

    await expectMigrationError(
      new EnvironmentMigrationCoordinator().run("workspace", harness.transaction, cancellation),
      "rollback-failed"
    );

    assert.deepStrictEqual(harness.rollbackCalls, ["source", "environment", "example"]);
    assert.deepStrictEqual([...harness.applied], ["gitignore", "environment"]);
  });

  test("serializes all operations for one workspace without overlap or premature tail cleanup", async () => {
    const coordinator = new EnvironmentMigrationCoordinator();
    const tracker = { active: 0, maximumActive: 0, starts: [] as string[] };
    const first = createBlockingTransaction("first", tracker);
    const second = createBlockingTransaction("second", tracker);
    const third = createBlockingTransaction("third", tracker);

    const firstRun = coordinator.run("workspace", first.transaction, new MutableCancellation());
    await first.started.promise;
    const secondRun = coordinator.run("workspace", second.transaction, new MutableCancellation());
    const thirdRun = coordinator.run("workspace", third.transaction, new MutableCancellation());
    await flushMicrotasks();

    assert.deepStrictEqual(tracker.starts, ["first"]);
    first.release.resolve();
    await second.started.promise;
    assert.deepStrictEqual(tracker.starts, ["first", "second"]);
    second.release.resolve();
    await third.started.promise;
    assert.deepStrictEqual(tracker.starts, ["first", "second", "third"]);
    third.release.resolve();

    await Promise.all([firstRun, secondRun, thirdRun]);
    assert.strictEqual(tracker.maximumActive, 1);
    assert.strictEqual(tracker.active, 0);
  });

  test("continues the same-workspace queue after a rejected operation", async () => {
    const coordinator = new EnvironmentMigrationCoordinator();
    const events: string[] = [];
    const firstFailure = new EnvironmentMigrationError("write-failed");
    const first = createMinimalTransaction(async () => {
      events.push("first");
      throw firstFailure;
    });
    const second = createMinimalTransaction(async () => {
      events.push("second");
    });

    const firstRun = expectMigrationError(
      coordinator.run("workspace", first, new MutableCancellation()),
      "write-failed"
    );
    const secondRun = coordinator.run("workspace", second, new MutableCancellation());

    await Promise.all([firstRun, secondRun]);
    assert.deepStrictEqual(events, ["first", "second"]);
  });

  test("allows different workspaces to run concurrently", async () => {
    const coordinator = new EnvironmentMigrationCoordinator();
    const tracker = { active: 0, maximumActive: 0, starts: [] as string[] };
    const first = createBlockingTransaction("first", tracker);
    const second = createBlockingTransaction("second", tracker);

    const firstRun = coordinator.run("workspace-a", first.transaction, new MutableCancellation());
    const secondRun = coordinator.run("workspace-b", second.transaction, new MutableCancellation());
    await Promise.all([first.started.promise, second.started.promise]);

    assert.deepStrictEqual(new Set(tracker.starts), new Set(["first", "second"]));
    assert.strictEqual(tracker.maximumActive, 2);
    first.release.resolve();
    second.release.resolve();

    await Promise.all([firstRun, secondRun]);
    assert.strictEqual(tracker.active, 0);
  });

  test("maps secret-bearing unknown exceptions to the fixed redacted message", async () => {
    const syntheticSecret = "synthetic-secret-that-must-never-be-rendered";
    const unknownFailure = new Error(`adapter failed near ${syntheticSecret}`);
    const normalized = normalizeEnvironmentMigrationError(unknownFailure, "write-failed");

    assert.strictEqual(
      getEnvironmentMigrationMessage(normalized),
      "Safe Code could not update the environment files. Its completed changes were restored."
    );
    assert.strictEqual(normalized.code, "write-failed");
    assert.ok(!normalized.message.includes(syntheticSecret));
    assert.ok(!normalized.toString().includes(syntheticSecret));

    const cancellation = new MutableCancellation();
    const transaction = createMinimalTransaction(async () => {
      throw unknownFailure;
    });
    const thrown = await expectMigrationError(
      new EnvironmentMigrationCoordinator().run("workspace", transaction, cancellation),
      "write-failed"
    );

    assert.strictEqual(getEnvironmentMigrationMessage(thrown), normalized.message);
    assert.ok(!thrown.message.includes(syntheticSecret));
    assert.ok(!thrown.toString().includes(syntheticSecret));
  });
});

class MutableCancellation implements EnvironmentMigrationCancellation {
  public constructor(public isCancellationRequested = false) {}
}

type HarnessOptions = {
  cancelAfterPrepare?: boolean;
  cancelAfterStep?: EnvironmentMigrationStep;
  cancelAfterVerify?: boolean;
  cancelBeforeStep?: EnvironmentMigrationStep;
  failAfterMutation?: EnvironmentMigrationStep;
  failBeforeMutation?: EnvironmentMigrationStep;
  mutationFailure?: EnvironmentMigrationError;
  rollbackFailures?: ReadonlySet<EnvironmentMigrationStep>;
  verifyFailure?: EnvironmentMigrationError;
};

function createHarness(cancellation: MutableCancellation, options: HarnessOptions = {}) {
  const applied = new Set<EnvironmentMigrationStep>();
  const events: string[] = [];
  const rollbackCalls: EnvironmentMigrationStep[] = [];
  const transaction: EnvironmentMigrationTransaction = {
    async prepare(): Promise<void> {
      events.push("prepare");
      if (options.cancelAfterPrepare) {
        cancellation.isCancellationRequested = true;
      }
    },
    async beforeStep(step): Promise<void> {
      events.push(`before:${step}`);
      if (options.cancelBeforeStep === step) {
        cancellation.isCancellationRequested = true;
      }
    },
    async apply(step): Promise<EnvironmentMigrationMutation> {
      events.push(`apply:${step}`);
      if (options.failBeforeMutation === step) {
        throw options.mutationFailure ?? new EnvironmentMigrationError("write-failed");
      }

      applied.add(step);
      const mutation: EnvironmentMigrationMutation = {
        step,
        async rollback(): Promise<void> {
          events.push(`rollback:${step}`);
          rollbackCalls.push(step);
          if (options.rollbackFailures?.has(step)) {
            throw new Error(`synthetic ${step} rollback failure`);
          }
          applied.delete(step);
        },
        async verify(): Promise<void> {
          events.push(`verify:${step}`);
        }
      };

      if (options.failAfterMutation === step) {
        throw new AppliedEnvironmentMigrationError(
          mutation,
          options.mutationFailure ?? new EnvironmentMigrationError("write-failed")
        );
      }
      if (options.cancelAfterStep === step) {
        cancellation.isCancellationRequested = true;
      }
      return mutation;
    },
    async verify(): Promise<void> {
      events.push("verify");
      if (options.verifyFailure) {
        throw options.verifyFailure;
      }
      if (options.cancelAfterVerify) {
        cancellation.isCancellationRequested = true;
      }
    }
  };

  return { applied, events, rollbackCalls, transaction };
}

function getFailureCode(step: EnvironmentMigrationStep): EnvironmentMigrationErrorCode {
  return step === "source" ? "source-edit-failed" : "write-failed";
}

function createMinimalTransaction(prepare: () => Promise<void>): EnvironmentMigrationTransaction {
  return {
    prepare,
    async beforeStep(): Promise<void> {},
    async apply(): Promise<undefined> {
      return undefined;
    },
    async verify(): Promise<void> {}
  };
}

type ConcurrencyTracker = {
  active: number;
  maximumActive: number;
  starts: string[];
};

function createBlockingTransaction(name: string, tracker: ConcurrencyTracker) {
  const started = createDeferred();
  const release = createDeferred();
  return {
    release,
    started,
    transaction: {
      async prepare(): Promise<void> {
        tracker.active += 1;
        tracker.maximumActive = Math.max(tracker.maximumActive, tracker.active);
        tracker.starts.push(name);
        started.resolve();
        await release.promise;
      },
      async beforeStep(): Promise<void> {},
      async apply(): Promise<undefined> {
        return undefined;
      },
      async verify(): Promise<void> {
        tracker.active -= 1;
      }
    } satisfies EnvironmentMigrationTransaction
  };
}

function createDeferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function expectMigrationError(
  operation: Promise<void>,
  expectedCode: EnvironmentMigrationErrorCode
): Promise<EnvironmentMigrationError> {
  let caught: unknown;
  try {
    await operation;
  } catch (error) {
    caught = error;
  }

  assert.ok(caught instanceof EnvironmentMigrationError, `Expected EnvironmentMigrationError, got ${String(caught)}`);
  assert.strictEqual(caught.code, expectedCode);
  return caught;
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}
