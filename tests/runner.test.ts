import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { AgentRunner } from "../src/observability/runner.js";

test("captures process lifecycle and output without changing behavior", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentwatch-test-"));
  const runner = await AgentRunner.open({ cwd: root });
  const run = await runner.run(["node", "-e", "process.stdout.write('agent ready')"], { cwd: root });
  assert.equal(run.exitCode, 0);
  assert.ok(run.stdout.includes("agent ready"));
  assert.ok(run.events.some((event) => event.kind === "session.start"));
  assert.ok(run.events.some((event) => event.kind === "session.end"));
  await fs.rm(root, { recursive: true, force: true });
});
