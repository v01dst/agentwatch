import assert from "node:assert/strict";
import test from "node:test";
import { comparisonLines, scoreCandidates } from "../src/benchmark/engine.js";

const fast = { agentId: "fast", passedTests: 10, failedTests: 0, durationMs: 100, commandCount: 20, inputTokens: 100 };
const thorough = { agentId: "thorough", passedTests: 8, failedTests: 2, durationMs: 150, commandCount: 30, inputTokens: 160 };

test("deterministic scoring ranks higher test pass rate first", () => {
  const [winner, loser] = scoreCandidates([thorough, fast]);
  assert.equal(winner!.candidate.agentId, "fast");
  assert.equal(loser!.candidate.agentId, "thorough");
});

test("comparison produces measurable explanations", () => {
  const [left, right] = scoreCandidates([fast, thorough]);
  const lines = comparisonLines(left!, right!);
  assert.ok(lines.some((line) => line.label === "execution time" && line.explanation.includes("% faster")));
  assert.ok(lines.some((line) => line.label === "commands" && line.explanation.includes("% fewer")));
});
