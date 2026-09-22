export const DEFAULT_MAX_FILE_SIZE_BYTES = 1024 * 1024;
export const DEFAULT_MAX_WORKSPACE_SCAN_FILES = 10_000;
export const DEFAULT_MAX_WORKSPACE_SCAN_BYTES = 100 * 1024 * 1024;
export const MAX_PENDING_SCANS = 256;

export type WorkspaceScanLimits = {
  maxFileSizeBytes: number;
  maxWorkspaceScanFiles: number;
  maxWorkspaceScanBytes: number;
};

export type ScanBudgetDecision =
  | "accepted"
  | "oversized"
  | "file-budget-exhausted"
  | "byte-budget-exhausted";

export type QueueEnqueueResult = "queued" | "coalesced" | "overflow";

export type QueuedScan<T> = {
  key: string;
  value: T;
  version: number;
};

export class BoundedScanQueue<T> {
  private readonly items = new Map<string, { value: T; version: number }>();
  private readonly activeVersions = new Map<string, number>();
  private nextVersion = 0;
  private overflowed = false;

  public constructor(private readonly capacity: number = MAX_PENDING_SCANS) {
    if (!isPositiveInteger(capacity)) {
      throw new Error("The scan queue capacity must be a positive integer.");
    }
  }

  public get size(): number {
    return this.items.size;
  }

  public get trackedSize(): number {
    return this.activeVersions.size;
  }

  public enqueue(key: string, value: T): QueueEnqueueResult {
    const version = this.createVersion();
    if (this.items.has(key)) {
      this.items.set(key, { value, version });
      this.activeVersions.set(key, version);
      return "coalesced";
    }

    if (this.items.size >= this.capacity) {
      this.activeVersions.delete(key);
      this.overflowed = true;
      return "overflow";
    }

    this.items.set(key, { value, version });
    this.activeVersions.set(key, version);
    return "queued";
  }

  public shift(): QueuedScan<T> | undefined {
    const first = this.items.entries().next();
    if (first.done) {
      return undefined;
    }

    const [key, item] = first.value;
    this.items.delete(key);
    return { key, value: item.value, version: item.version };
  }

  public remove(key: string): boolean {
    this.activeVersions.delete(key);
    return this.items.delete(key);
  }

  public removeWhere(predicate: (key: string) => boolean): number {
    let removed = 0;
    for (const key of this.activeVersions.keys()) {
      if (predicate(key)) {
        this.activeVersions.delete(key);
        this.items.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  public begin(key: string): number {
    const version = this.createVersion();
    this.activeVersions.set(key, version);
    return version;
  }

  public isCurrent(key: string, version: number): boolean {
    return this.activeVersions.get(key) === version;
  }

  public release(key: string, version: number): void {
    if (this.isCurrent(key, version)) {
      this.activeVersions.delete(key);
    }
  }

  public consumeOverflow(): boolean {
    const overflowed = this.overflowed;
    this.overflowed = false;
    return overflowed;
  }

  public clear(): void {
    this.items.clear();
    this.activeVersions.clear();
    this.overflowed = false;
  }

  private createVersion(): number {
    this.nextVersion += 1;
    return this.nextVersion;
  }
}

export class WorkspaceScanBudget {
  private acceptedFilesValue = 0;
  private acceptedBytesValue = 0;

  public constructor(private readonly limits: WorkspaceScanLimits) {
    if (
      !isPositiveInteger(limits.maxFileSizeBytes) ||
      !isPositiveInteger(limits.maxWorkspaceScanFiles) ||
      !isPositiveInteger(limits.maxWorkspaceScanBytes)
    ) {
      throw new Error("Workspace scan limits must be positive integers.");
    }
  }

  public get acceptedFiles(): number {
    return this.acceptedFilesValue;
  }

  public get acceptedBytes(): number {
    return this.acceptedBytesValue;
  }

  public get remainingBytes(): number {
    return this.limits.maxWorkspaceScanBytes - this.acceptedBytesValue;
  }

  public check(byteLength: number): ScanBudgetDecision {
    if (!Number.isSafeInteger(byteLength) || byteLength < 0) {
      throw new Error("A file byte length must be a non-negative integer.");
    }

    if (byteLength > this.limits.maxFileSizeBytes) {
      return "oversized";
    }

    if (this.acceptedFilesValue >= this.limits.maxWorkspaceScanFiles) {
      return "file-budget-exhausted";
    }

    if (byteLength > this.remainingBytes) {
      return "byte-budget-exhausted";
    }

    return "accepted";
  }

  public accept(byteLength: number): ScanBudgetDecision {
    const decision = this.check(byteLength);
    if (decision === "accepted") {
      this.acceptedFilesValue += 1;
      this.acceptedBytesValue += byteLength;
    }

    return decision;
  }
}

export function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export function utf8ByteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

export function getDiscoveryMaxResults(maxWorkspaceScanFiles: number): number {
  if (!isPositiveInteger(maxWorkspaceScanFiles)) {
    throw new Error("The workspace file limit must be a positive integer.");
  }

  return Math.min(maxWorkspaceScanFiles + 1, Number.MAX_SAFE_INTEGER);
}

export function shouldCleanupStaleDiagnostics(cancelled: boolean, partial: boolean): boolean {
  return !cancelled && !partial;
}

export function getStaleDiagnosticKeys(
  previousKeys: Iterable<string>,
  currentKeys: ReadonlySet<string>,
  cancelled: boolean,
  partial: boolean
): string[] {
  if (!shouldCleanupStaleDiagnostics(cancelled, partial)) {
    return [];
  }

  return [...previousKeys].filter((key) => !currentKeys.has(key));
}
