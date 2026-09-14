export const workspaceScanStressEventCount = 10_000;
export const workspaceScanStressEligibleFileCount = 9_800;
export const workspaceScanStressFindingCount = 10;

export const workspaceScanStressEvents = Array.from(
  { length: workspaceScanStressEventCount },
  (_, index) => {
    const ignored = index % 100 === 0;
    const unsupported = index % 100 === 1;
    const containsSecret = index % 1000 === 2;
    const fileName = unsupported ? `notes-${index}.txt` : `source-${index}.ts`;
    const relativePath = ignored ? `node_modules/stress/${fileName}` : `src/stress/${fileName}`;
    const text = containsSecret
      ? `const apiKey = "benchmark-secret-${index}";`
      : `export const benchmarkValue${index} = true;`;

    return {
      fileName,
      key: `file:///stress/${relativePath}`,
      relativePath,
      text,
      value: index
    };
  }
);
