import * as assert from "assert";
import { defaultIgnoredPaths, scanText, shouldScanFile } from "../../src/scannerCore";

suite("scanner core", () => {
  test("detects every specialized secret rule", () => {
    const cases = [
      ["private-key", "-----BEGIN PRIVATE KEY-----"],
      ["github-token", "ghp_1234567890abcdefghij"],
      ["github-fine-grained-token", "github_pat_1234567890abcdefghij"],
      ["aws-access-key", "AKIA1234567890ABCDEF"],
      ["stripe-live-key", "sk_live_123456789abc"],
      ["database-url", "postgres://user:password@example.com/app"]
    ] as const;

    for (const [expectedRuleId, text] of cases) {
      const findings = scanText(text, { minimumSecretLength: 8 });
      assert.ok(findings.some((finding) => finding.ruleId === expectedRuleId), expectedRuleId);
    }
  });

  test("detects quoted and unquoted secret assignments", () => {
    const text = [
      "const clientSecret = \"super-secret-value\";",
      "export DATABASE_URL=postgres://user:pass@example.com/app"
    ].join("\n");

    const findings = scanText(text, { minimumSecretLength: 8 });

    assert.deepStrictEqual(
      findings.map((finding) => finding.ruleId),
      ["generic-secret-assignment", "database-url"]
    );
    assert.strictEqual(findings[0].value, "super-secret-value");
    assert.strictEqual(findings[1].value, "postgres://user:pass@example.com/app");
  });

  test("rejects placeholders and generic values below the configured minimum", () => {
    const placeholders = [
      'const apiKey = "your-api-key-here";',
      'const token = "replace_me";',
      'const password = "xxxxxxxx";',
      'const clientSecret = "sample";'
    ].join("\n");

    assert.deepStrictEqual(scanText(placeholders, { minimumSecretLength: 8 }), []);
    assert.deepStrictEqual(scanText('const apiKey = "12345678";', { minimumSecretLength: 12 }), []);
    assert.strictEqual(scanText('const apiKey = "12345678";', { minimumSecretLength: 8 }).length, 1);
  });

  test("returns exact offsets, line text, and deterministic source order", () => {
    const text = [
      "// safe preface",
      'const token = "abcdefghijk";',
      "-----BEGIN PRIVATE KEY-----"
    ].join("\r\n");
    const findings = scanText(text, { minimumSecretLength: 8 });
    const tokenOffset = text.indexOf("abcdefghijk");

    assert.strictEqual(findings.length, 2);
    assert.strictEqual(findings[0].startOffset, tokenOffset);
    assert.strictEqual(findings[0].endOffset, tokenOffset + "abcdefghijk".length);
    assert.strictEqual(findings[0].lineText, 'const token = "abcdefghijk";');
    assert.strictEqual(findings[1].ruleId, "private-key");
    assert.ok(findings[0].startOffset < findings[1].startOffset);
  });

  test("keeps the higher-severity finding when rules cover the same range", () => {
    const findings = scanText('const apiKey = "sk_live_123456789abc";', { minimumSecretLength: 8 });

    assert.strictEqual(findings.length, 1);
    assert.strictEqual(findings[0].ruleId, "stripe-live-key");
    assert.strictEqual(findings[0].severity, "high");
  });

  test("accepts supported extensions and environment-file variants", () => {
    for (const fileName of ["source.ts", "component.TSX", "config.yaml", ".env", ".env.local"]) {
      assert.strictEqual(shouldScanFile(fileName, fileName, defaultIgnoredPaths), true, fileName);
    }

    assert.strictEqual(shouldScanFile("notes.txt", "notes.txt", defaultIgnoredPaths), false);
  });

  test("honors default and custom ignored globs with normalized separators", () => {
    assert.strictEqual(shouldScanFile("secret.ts", "node_modules/pkg/secret.ts", defaultIgnoredPaths), false);
    assert.strictEqual(shouldScanFile("secret.ts", "src\\generated\\secret.ts", ["**/generated/**"]), false);
    assert.strictEqual(shouldScanFile("secret.ts", "generated/secret.ts", ["**/generated/**"]), false);
    assert.strictEqual(shouldScanFile("secret.ts", "src/secret.ts", ["**/generated/**"]), true);
  });
});
