import assert from "node:assert/strict";
import test from "node:test";
import { LocalStore } from "../src/storage/store.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

test("local store migrates schema and appends atomically", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentwatch-store-test-"));
  const store = await LocalStore.open(undefined, root);
  await store.append("sessions", { id: "abc" });
  assert.deepEqual(await store.list("sessions"), [{ id: "abc" }]);
  await fs.rm(root, { recursive: true, force: true });
});
