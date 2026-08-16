import * as assert from "assert";
import {
  analyzeEnvironmentAssignment,
  ensureEnvironmentFileIgnored,
  EnvironmentVariableConflictError,
  inferEnvironmentVariableName,
  isSupportedEnvironmentFixFile,
  upsertEnvironmentExample,
  upsertEnvironmentValue
} from "../../src/environmentFixCore";

suite("environment fix core", () => {
  test("analyzes simple JavaScript and TypeScript assignments", () => {
    const declaration = 'export const clientSecret: string = "real-secret-value";';
    const declarationStart = declaration.indexOf("real-secret-value");
    assert.deepStrictEqual(
      analyzeEnvironmentAssignment(
        declaration,
        declarationStart,
        declarationStart + "real-secret-value".length
      ),
      {
        environmentVariableName: "CLIENT_SECRET",
        replacementEndCharacter: declaration.lastIndexOf('"') + 1,
        replacementStartCharacter: declaration.indexOf('"'),
        replacement: "process.env.CLIENT_SECRET",
        secretValue: "real-secret-value",
        variableName: "clientSecret"
      }
    );

    const assignment = "  api_token = 'another-secret-value'";
    const assignmentStart = assignment.indexOf("another-secret-value");
    assert.strictEqual(
      analyzeEnvironmentAssignment(
        assignment,
        assignmentStart,
        assignmentStart + "another-secret-value".length
      )?.replacement,
      "process.env.API_TOKEN"
    );
  });

  test("rejects ambiguous assignments and stale diagnostic ranges", () => {
    const ambiguousLines = [
      'const config = { apiKey: "object-secret-value" };',
      'const apiKey = `template-secret-value`;',
      'const apiKey = "secret-" + suffix;',
      'const apiKey = getSecret("secret-value");',
      'const apiKey = "first-secret", token = "second-secret";',
      'service.apiKey = "property-secret-value";'
    ];

    for (const line of ambiguousLines) {
      const valueStart = line.indexOf("secret");
      assert.strictEqual(
        analyzeEnvironmentAssignment(line, valueStart, valueStart + "secret".length),
        undefined,
        line
      );
    }

    const supported = 'const apiKey = "range-secret-value";';
    const valueStart = supported.indexOf("range-secret-value");
    assert.strictEqual(analyzeEnvironmentAssignment(supported, valueStart + 1, supported.lastIndexOf('"')), undefined);
  });

  test("infers portable environment variable names and supported files", () => {
    assert.strictEqual(inferEnvironmentVariableName("apiKey"), "API_KEY");
    assert.strictEqual(inferEnvironmentVariableName("GitHubPATToken"), "GIT_HUB_PAT_TOKEN");
    assert.strictEqual(inferEnvironmentVariableName("$database_url"), "DATABASE_URL");
    assert.strictEqual(inferEnvironmentVariableName("$_"), undefined);

    for (const fileName of ["config.js", "config.JSX", "config.ts", "config.tsx"]) {
      assert.strictEqual(isSupportedEnvironmentFixFile(fileName), true, fileName);
    }
    assert.strictEqual(isSupportedEnvironmentFixFile("config.json"), false);
    assert.strictEqual(isSupportedEnvironmentFixFile(".env"), false);
  });

  test("updates environment files without exposing values in the example", () => {
    assert.strictEqual(upsertEnvironmentValue("", "API_KEY", "secret value #1"), 'API_KEY="secret value #1"\n');
    assert.strictEqual(
      upsertEnvironmentValue('EXISTING="value"\r\n', "API_KEY", "secret-value"),
      'EXISTING="value"\r\nAPI_KEY="secret-value"\r\n'
    );
    assert.strictEqual(upsertEnvironmentExample("EXISTING=\n", "API_KEY"), "EXISTING=\nAPI_KEY=\n");
    assert.strictEqual(upsertEnvironmentExample("API_KEY=placeholder\n", "API_KEY"), "API_KEY=placeholder\n");
  });

  test("does not overwrite conflicting environment values", () => {
    assert.throws(
      () => upsertEnvironmentValue('API_KEY="existing-secret"\n', "API_KEY", "different-secret"),
      EnvironmentVariableConflictError
    );
    assert.strictEqual(
      upsertEnvironmentValue('API_KEY="same-secret"\n', "API_KEY", "same-secret"),
      'API_KEY="same-secret"\n'
    );
  });

  test("adds an exact root environment ignore idempotently", () => {
    assert.strictEqual(ensureEnvironmentFileIgnored("node_modules/\n"), "node_modules/\n.env\n");
    assert.strictEqual(ensureEnvironmentFileIgnored("/.env\n"), "/.env\n");
    assert.strictEqual(ensureEnvironmentFileIgnored(".env.*\n"), ".env.*\n.env\n");
  });
});
