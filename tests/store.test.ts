import assert from "node:assert/strict";
import test from "node:test";
import { LocalStore } from "../src/storage/store.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

test("local store migrates schema and appends atomically", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentwatch-store-test-"));
  const store = await LocalStore.open(undefined, root);
  await store.writeManifest({
    id: "abc", schemaVersion: 2, startedAt: new Date().toISOString(), command: ["node"],
    cwd: root, adapter: "generic", status: "success", complete: true,
  });
  assert.equal((await store.list("sessions"))[0]?.id, "abc");
  await fs.rm(root, { recursive: true, force: true });
});
