import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { LocalStore } from "../src/storage/store.js";

test("schema migrates to version 2 and supports manifests", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentwatch-v2-"));
  const store = await LocalStore.open(undefined, root);
  const writer = await store.createSessionWriter("session-1");
  await writer.close();
  await store.writeManifest({
    id: "session-1", schemaVersion: 2, startedAt: new Date().toISOString(),
    command: ["node"], cwd: root, adapter: "generic", status: "running", complete: false,
  });
  const recovered = await store.recoverIncompleteSessions();
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0]!.status, "incomplete");
  const manifest = await store.readManifest("session-1");
  assert.equal(manifest?.complete, true);
});

test("benchmark catalog replaces results with the same id", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentwatch-bench-"));
  const store = await LocalStore.open(undefined, root);
  const record = { id: "same", task: "demo", candidates: [] };
  await store.append("benchmarks", record);
  await store.append("benchmarks", record);
  assert.equal((await store.list("benchmarks")).length, 1);
});
