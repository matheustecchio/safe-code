const { defineConfig } = require("@vscode/test-cli");

module.exports = defineConfig({
  label: "integration",
  files: ".test-out/test/integration/**/*.test.js",
  version: "1.90.0",
  workspaceFolder: "test/fixtures/workspace",
  launchArgs: ["--disable-extensions"],
  mocha: {
    ui: "tdd",
    timeout: 20_000,
    color: true
  }
});
