import * as assert from "assert";
import {
  createIgnoredWarning,
  hashLineText,
  matchesIgnoredWarning,
  normalizeProjectFilePath,
  parseProjectIgnoreConfig,
  ProjectIgnoreConfigError,
  serializeProjectIgnoreConfig
} from "../../src/ignoreCore";

suite("ignore core", () => {
  test("creates stable warning identities from trimmed line text", () => {
    const warning = createIgnoredWarning("src/config.ts", '  const apiKey = "secret-value";  ', "generic-secret");

    assert.strictEqual(warning.filePath, "src/config.ts");
    assert.strictEqual(warning.lineHash.length, 24);
    assert.strictEqual(warning.lineHash, hashLineText('const apiKey = "secret-value";'));
    assert.ok(matchesIgnoredWarning(warning, { ...warning }));
    assert.ok(!matchesIgnoredWarning(warning, { ...warning, ruleId: "another-rule" }));
  });

  test("normalizes portable workspace-relative paths", () => {
    assert.strictEqual(normalizeProjectFilePath("./src\\nested//config.ts"), "src/nested/config.ts");
  });

  test("parses, normalizes, and deduplicates valid project configuration", () => {
    const lineHash = hashLineText("secret line");
    const config = parseProjectIgnoreConfig(
      JSON.stringify({
        version: 1,
        ignoredWarnings: [
          { filePath: "src\\config.ts", lineHash, ruleId: "generic-secret" },
          { filePath: "src/config.ts", lineHash, ruleId: "generic-secret" }
        ]
      })
    );

    assert.deepStrictEqual(config, {
      version: 1,
      ignoredWarnings: [{ filePath: "src/config.ts", lineHash, ruleId: "generic-secret" }]
    });
    assert.deepStrictEqual(parseProjectIgnoreConfig(serializeProjectIgnoreConfig(config)), config);
  });

  test("rejects malformed project configuration without accepting partial entries", () => {
    const invalidConfigs = [
      "not json",
      JSON.stringify([]),
      JSON.stringify({ version: 2, ignoredWarnings: [] }),
      JSON.stringify({ version: 1 }),
      JSON.stringify({ version: 1, ignoredWarnings: [], unexpected: true }),
      JSON.stringify({
        version: 1,
        ignoredWarnings: [
          { filePath: "src/file.ts", lineHash: hashLineText("line"), ruleId: "rule", unexpected: true }
        ]
      }),
      JSON.stringify({
        version: 1,
        ignoredWarnings: [{ filePath: "../outside.ts", lineHash: hashLineText("line"), ruleId: "rule" }]
      }),
      JSON.stringify({
        version: 1,
        ignoredWarnings: [{ filePath: "/absolute.ts", lineHash: hashLineText("line"), ruleId: "rule" }]
      }),
      JSON.stringify({
        version: 1,
        ignoredWarnings: [{ filePath: "src/file.ts", lineHash: "invalid", ruleId: "rule" }]
      }),
      JSON.stringify({
        version: 1,
        ignoredWarnings: [{ filePath: "src/file.ts", lineHash: hashLineText("line"), ruleId: "" }]
      })
    ];

    for (const content of invalidConfigs) {
      assert.throws(() => parseProjectIgnoreConfig(content), ProjectIgnoreConfigError);
    }
  });
});
