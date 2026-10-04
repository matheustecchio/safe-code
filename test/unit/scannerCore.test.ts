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
      for (const fileName of ["source.ts", "source.py", "config.json", ".env"]) {
        const findings = scanText(text, { minimumSecretLength: 8, fileName });
        assert.strictEqual(findings.length, 1, `${fileName}: ${expectedRuleId}`);
        assert.strictEqual(findings[0].ruleId, expectedRuleId);
        assert.strictEqual(findings[0].startOffset, 0);
        assert.strictEqual(findings[0].endOffset, text.length);
        assert.strictEqual(findings[0].value, text);
      }
    }
  });

  test("detects quoted and unquoted secret assignments", () => {
    const text = [
      "const clientSecret = \"super-secret-value\";",
      "export DATABASE_URL=postgres://user:pass@example.com/app"
    ].join("\n");

    const findings = scanText(text, { minimumSecretLength: 8, fileName: "source.ts" });

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

    assert.deepStrictEqual(scanText(placeholders, { minimumSecretLength: 8, fileName: "source.ts" }), []);
    assert.deepStrictEqual(scanText('const apiKey = "12345678";', { minimumSecretLength: 12, fileName: "source.ts" }), []);
    assert.strictEqual(scanText('const apiKey = "12345678";', { minimumSecretLength: 8, fileName: "source.ts" }).length, 1);
  });

  test("returns exact offsets, line text, and deterministic source order", () => {
    const text = [
      "// safe preface",
      'const token = "abcdefghijk";',
      "-----BEGIN PRIVATE KEY-----"
    ].join("\r\n");
    const findings = scanText(text, { minimumSecretLength: 8, fileName: "source.ts" });
    const tokenOffset = text.indexOf("abcdefghijk");

    assert.strictEqual(findings.length, 2);
    assert.strictEqual(findings[0].startOffset, tokenOffset);
    assert.strictEqual(findings[0].endOffset, tokenOffset + "abcdefghijk".length);
    assert.strictEqual(findings[0].lineText, 'const token = "abcdefghijk";');
    assert.strictEqual(findings[1].ruleId, "private-key");
    assert.ok(findings[0].startOffset < findings[1].startOffset);
  });

  test("keeps the higher-severity finding when rules cover the same range", () => {
    const findings = scanText('const apiKey = "sk_live_123456789abc";', { minimumSecretLength: 8, fileName: "source.ts" });

    assert.strictEqual(findings.length, 1);
    assert.strictEqual(findings[0].ruleId, "stripe-live-key");
    assert.strictEqual(findings[0].severity, "high");
  });

  test("does not treat unquoted source expressions as dotenv credentials", () => {
    const expressions = [
      "privateKeyOpenSSL = clientCertificate.privateKey.original",
      "configuration = CertificateOptions(\n    privateKey=privateKeyOpenSSL,\n)",
      'apiKey = os.getenv("API_KEY")',
      "token = ordinaryIdentifierWithALongName",
      "password = True", "secret = None", "token = False",
      "apiKey = process.env.API_KEY;",
      'clientSecret = getSecret("CLIENT_SECRET");',
      "password = false;", "token = undefined;", "secret = null;"
    ];
    for (const fileName of ["src/first-party.py", "source.js", "source.ts", "config.yaml", "config.ini", "unknown", ".env-config.ts"]) {
      for (const text of expressions) {
        assert.deepStrictEqual(scanText(text, { minimumSecretLength: 8, fileName }), [], `${fileName}: ${text}`);
      }
    }
  });

  test("restricts unquoted dotenv values to explicit case-insensitive environment filenames", () => {
    for (const fileName of [".env", "config/.env.local", ".ENV", "config/.EnV.Production", "C:\\project\\.ENV.local"]) {
      for (const prefix of ["API_KEY=", "export CLIENT_SECRET="]) {
        const value = "synthetic-credential-value";
        const text = prefix + value;
        const findings = scanText(text, { minimumSecretLength: 8, fileName });
        assert.strictEqual(findings.length, 1, fileName);
        assert.strictEqual(findings[0].ruleId, "env-secret-assignment");
        assert.strictEqual(findings[0].value, value);
        assert.strictEqual(findings[0].startOffset, prefix.length);
        assert.strictEqual(findings[0].endOffset, text.length);
      }
      assert.deepStrictEqual(scanText("API_KEY=your-api-key-here", { minimumSecretLength: 8, fileName }), []);
      assert.deepStrictEqual(scanText("API_KEY=abcdefgh", { minimumSecretLength: 12, fileName }), []);
    }
  });

  test("preserves literal assignment rule IDs and exact ranges across file contexts", () => {
    const value = "literal-secret-value";
    for (const fileName of ["source.py", "source.js", "source.ts", "config.json", ".env", ".ENV.local"]) {
      for (const text of ['apiKey = "literal-secret-value"', '    privateKey="literal-secret-value",', '{"apiKey": "literal-secret-value"}', "token = `literal-secret-value`", "token = 'literal-secret-value'"]) {
        const findings = scanText(text, { minimumSecretLength: 8, fileName });
        assert.strictEqual(findings.length, 1, fileName);
        assert.strictEqual(findings[0].ruleId, "generic-secret-assignment");
        assert.strictEqual(findings[0].value, value);
        assert.strictEqual(findings[0].startOffset, text.indexOf(value));
        assert.strictEqual(findings[0].endOffset, text.indexOf(value) + value.length);
      }
    }
  });

  test("skips interpolated templates but preserves escaped literal interpolation and specialized signatures", () => {
    for (const fileName of ["source.js", "source.ts", "source.TSX"]) {
      for (const text of ['const apiKey = `${process.env.API_KEY}`;', 'const token = `prefix-${ordinaryIdentifier}`;', 'const token = `prefix-\\\\${ordinaryIdentifier}`;']) {
        assert.deepStrictEqual(scanText(text, { minimumSecretLength: 8, fileName }), [], text);
      }
      const literal = 'const token = `prefix-\\${literal-text}`;';
      const findings = scanText(literal, { minimumSecretLength: 8, fileName });
      assert.strictEqual(findings.length, 1);
      assert.strictEqual(findings[0].ruleId, "generic-secret-assignment");
      assert.strictEqual(literal.slice(findings[0].startOffset, findings[0].endOffset), 'prefix-\\${literal-text}');
      const specialized = 'const apiKey = `sk_live_123456789abc${suffix}`;';
      const matches = scanText(specialized, { minimumSecretLength: 8, fileName });
      assert.strictEqual(matches.length, 1);
      assert.strictEqual(matches[0].ruleId, "stripe-live-key");
      assert.strictEqual(specialized.slice(matches[0].startOffset, matches[0].endOffset), "sk_live_123456789abc");
    }
  });

  test("accepts supported extensions and environment-file variants", () => {
    for (const fileName of [
      "source.ts",
      "component.TSX",
      "config.yaml",
      ".env",
      ".env.local",
      ".env.production",
      ".env-config.ts"
    ]) {
      assert.strictEqual(shouldScanFile(fileName, fileName, defaultIgnoredPaths), true, fileName);
    }

    assert.strictEqual(shouldScanFile("notes.txt", "notes.txt", defaultIgnoredPaths), false);
  });

  test("ignores only exact environment directory names at any workspace depth", () => {
    for (const directory of [".env", ".venv", "venv", ".environment"]) {
      for (const relativePath of [
        `${directory}/secret.ts`,
        `nested/${directory}/secret.ts`,
        `nested/${directory}/lib64/python3.12/site-packages/twisted/internet/endpoints.py`
      ]) {
        for (const normalizedPath of [relativePath, relativePath.replace(/\//g, "\\")]) {
          assert.strictEqual(shouldScanFile("secret.ts", normalizedPath, defaultIgnoredPaths), false, normalizedPath);
        }
      }
    }

    for (const directory of [".env.local", ".env-config", "my.env", ".venv-config", "my.venv", ".environment-config", "env", "environment"]) {
      for (const relativePath of [`${directory}/secret.ts`, `nested/${directory}/secret.ts`]) {
        assert.strictEqual(shouldScanFile("secret.ts", relativePath, defaultIgnoredPaths), true, relativePath);
        assert.strictEqual(shouldScanFile("secret.ts", relativePath.replace(/\//g, "\\"), defaultIgnoredPaths), true, relativePath);
      }
    }
  });

  test("honors default and custom ignored globs with normalized separators", () => {
    assert.strictEqual(shouldScanFile("secret.ts", "node_modules/pkg/secret.ts", defaultIgnoredPaths), false);
    assert.strictEqual(shouldScanFile("secret.ts", "src\\generated\\secret.ts", ["**/generated/**"]), false);
    assert.strictEqual(shouldScanFile("secret.ts", "generated/secret.ts", ["**/generated/**"]), false);
    assert.strictEqual(shouldScanFile("secret.ts", "src/secret.ts", ["**/generated/**"]), true);
  });
});
