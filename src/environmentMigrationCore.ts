export type EnvironmentMigrationErrorCode =
  | "cancelled"
  | "concurrent-change"
  | "conflict"
  | "git-unavailable"
  | "invalid-source"
  | "rollback-failed"
  | "source-edit-failed"
  | "tracked-environment"
  | "unsafe-target"
  | "write-failed";

const safeMessages: Record<EnvironmentMigrationErrorCode, string> = {
  cancelled: "Safe Code cancelled the migration and restored its changes.",
  "concurrent-change": "Safe Code stopped because a migration input changed. No changes were kept.",
  conflict: "Safe Code stopped because the environment variable already has a different value. No changes were kept.",
  "git-unavailable": "Safe Code could not verify that .env is protected by Git. No changes were kept.",
  "invalid-source": "Safe Code stopped because the source assignment changed or is no longer supported. No changes were kept.",
  "rollback-failed": "Safe Code could not safely restore every change. Keep .env private and inspect the affected files manually.",
  "source-edit-failed": "Safe Code could not update the source assignment. Its environment-file changes were restored.",
  "tracked-environment": "Safe Code will not write a secret because .env is tracked by Git. No changes were kept.",
  "unsafe-target": "Safe Code will only update safe, regular UTF-8 environment files. No changes were kept.",
  "write-failed": "Safe Code could not update the environment files. Its completed changes were restored."
};

export class EnvironmentMigrationError extends Error {
  public constructor(
    public readonly code: EnvironmentMigrationErrorCode,
    options?: { cause?: unknown }
  ) {
    super(safeMessages[code], options);
    this.name = "EnvironmentMigrationError";
  }
}

export type EnvironmentMigrationStep = "gitignore" | "example" | "environment" | "source";

export type EnvironmentMigrationMutation = {
  step: EnvironmentMigrationStep;
  rollback(): Promise<void>;
  verify(): Promise<void>;
};

export class AppliedEnvironmentMigrationError extends Error {
  public constructor(
    public readonly mutation: EnvironmentMigrationMutation,
    public readonly migrationError: EnvironmentMigrationError
  ) {
    super("A migration step failed after applying a recoverable change.");
    this.name = "AppliedEnvironmentMigrationError";
  }
}

export type EnvironmentMigrationTransaction = {
  prepare(): Promise<void>;
  beforeStep(step: EnvironmentMigrationStep): Promise<void>;
  apply(step: EnvironmentMigrationStep): Promise<EnvironmentMigrationMutation | undefined>;
  verify(): Promise<void>;
};

export type EnvironmentMigrationCancellation = {
  readonly isCancellationRequested: boolean;
};

export function getEnvironmentMigrationMessage(error: unknown): string {
  return error instanceof EnvironmentMigrationError
    ? safeMessages[error.code]
    : safeMessages["write-failed"];
}

export function normalizeEnvironmentMigrationError(
  error: unknown,
  fallback: EnvironmentMigrationErrorCode
): EnvironmentMigrationError {
  if (error instanceof EnvironmentMigrationError) {
    return error;
  }
  return new EnvironmentMigrationError(fallback, { cause: error });
}

export class EnvironmentMigrationCoordinator {
  private readonly tails = new Map<string, Promise<void>>();

  public async run(
    workspaceKey: string,
    transaction: EnvironmentMigrationTransaction,
    cancellation: EnvironmentMigrationCancellation
  ): Promise<void> {
    const previous = this.tails.get(workspaceKey) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.catch(() => undefined).then(() => gate);
    this.tails.set(workspaceKey, tail);

    await previous.catch(() => undefined);
    try {
      await this.runLocked(transaction, cancellation);
    } finally {
      release();
      if (this.tails.get(workspaceKey) === tail) {
        this.tails.delete(workspaceKey);
      }
    }
  }

  private async runLocked(
    transaction: EnvironmentMigrationTransaction,
    cancellation: EnvironmentMigrationCancellation
  ): Promise<void> {
    const journal: EnvironmentMigrationMutation[] = [];

    try {
      throwIfCancelled(cancellation);
      await transaction.prepare();
      throwIfCancelled(cancellation);

      for (const step of ["gitignore", "example", "environment", "source"] as const) {
        await transaction.beforeStep(step);
        throwIfCancelled(cancellation);
        try {
          const mutation = await transaction.apply(step);
          if (mutation) {
            journal.push(mutation);
          }
        } catch (error) {
          if (error instanceof AppliedEnvironmentMigrationError) {
            journal.push(error.mutation);
            throw error.migrationError;
          }
          throw error;
        }
        throwIfCancelled(cancellation);
      }

      await transaction.verify();
      throwIfCancelled(cancellation);
    } catch (error) {
      const migrationError = normalizeEnvironmentMigrationError(error, "write-failed");
      const rollbackFailed = await rollbackJournal(journal);
      if (rollbackFailed) {
        throw new EnvironmentMigrationError("rollback-failed", { cause: migrationError });
      }
      throw migrationError;
    }
  }
}

function throwIfCancelled(cancellation: EnvironmentMigrationCancellation): void {
  if (cancellation.isCancellationRequested) {
    throw new EnvironmentMigrationError("cancelled");
  }
}

async function rollbackJournal(journal: EnvironmentMigrationMutation[]): Promise<boolean> {
  let rollbackFailed = false;
  let retainEnvironmentFile = false;
  let retainEnvironmentProtection = false;

  for (const mutation of [...journal].reverse()) {
    if (retainEnvironmentFile && mutation.step === "environment") {
      continue;
    }
    if (retainEnvironmentProtection && mutation.step === "gitignore") {
      continue;
    }

    try {
      await mutation.rollback();
    } catch {
      rollbackFailed = true;
      if (mutation.step === "source") {
        retainEnvironmentFile = true;
        retainEnvironmentProtection = true;
      } else if (mutation.step === "environment") {
        retainEnvironmentProtection = true;
      }
    }
  }

  return rollbackFailed;
}
