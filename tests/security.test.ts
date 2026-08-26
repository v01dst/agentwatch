import assert from "node:assert/strict";
import test from "node:test";
import { analyzeEvents, scanText } from "../src/analysis/security.js";

test("detects and redacts provider secrets", async () => {
  const findings = await scanText("OPENAI_API_KEY=sk-abcdef1234567890abcdef123456");
  assert.equal(findings.length, 1);
  assert.equal(findings[0]!.category, "secret");
  assert.ok(!JSON.stringify(findings).includes("sk-abcdef1234567890abcdef123456"));
  assert.ok(findings[0]!.evidence!.endsWith("[redacted]"));
});

test("flags risky commands without exposing full evidence", () => {
  const findings = analyzeEvents([{ kind: "output.stdout", data: { line: "rm -rf /tmp/example" } }]);
  assert.equal(findings[0]?.category, "suspicious-command");
});
