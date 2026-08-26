import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { LocalStore } from "../src/storage/store.js";
import { buildLeaderboard } from "../src/observability/dashboard.js";

test("leaderboard aggregates deterministic benchmark history", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentwatch-board-"));
  const store = await LocalStore.open(undefined, root);
  for (let index = 0; index < 2; index++) {
    await store.append("benchmarks", {
      id: `run-${index}`, task: "same-task", createdAt: new Date().toISOString(),
      candidates: [
        { score: 80 + index, candidate: { agentId: "fast", passedTests: 10, failedTests: 0, durationMs: 100, commandCount: 20 } },
        { score: 70 + index, candidate: { agentId: "slow", passedTests: 8, failedTests: 2, durationMs: 200, commandCount: 40 } },
      ],
    });
  }
  const entries = await buildLeaderboard(store, "same-task");
  assert.equal(entries[0]?.agent, "fast");
  assert.equal(entries[0]?.wins, 2);
});
