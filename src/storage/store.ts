import fs from "node:fs/promises";
import path from "node:path";
import type { AgentWatchEvent, JsonValue, SessionStatus } from "../types.js";
import { resolveConfig, type ResolvedConfig } from "../config/index.js";

interface StoreFile {
  schemaVersion: number;
  records: Array<Record<string, JsonValue>>;
}

export interface SessionRecord extends Record<string, JsonValue> {
  id: string;
  schemaVersion: number;
  startedAt: string;
  endedAt?: string;
  exitCode?: number | null;
  signal?: string | null;
  durationMs?: number;
  command: string[];
  cwd: string;
  adapter: string;
  status: SessionStatus;
  pid?: number | null;
  eventCount?: number;
  complete?: boolean;
  recoveredAt?: string;
}

export interface StreamingSessionWriter {
  write(event: AgentWatchEvent): Promise<void>;
  close(): Promise<void>;
}

class NdjsonSessionWriter implements StreamingSessionWriter {
  constructor(private readonly handle: fs.FileHandle) {}

  static async open(filePath: string): Promise<NdjsonSessionWriter> {
    return new NdjsonSessionWriter(await fs.open(filePath, "a", 0o600));
  }

  async write(event: AgentWatchEvent): Promise<void> {
    await this.handle.writeFile(`${JSON.stringify(event)}\n`);
  }

  async close(): Promise<void> {
    await this.handle.sync();
    await this.handle.close();
  }
}

export class LocalStore {
  constructor(private readonly config: ResolvedConfig) {}

  static async open(projectRoot?: string, dataDirectory?: string): Promise<LocalStore> {
    const config = resolveConfig(projectRoot, dataDirectory);
    await fs.mkdir(config.dataDir, { recursive: true });
    await fs.mkdir(config.sessionsDir, { recursive: true });
    await fs.mkdir(config.exportsDir, { recursive: true });
    await migrate(config.databasePath);
    return new LocalStore(config);
  }

  async append(collection: "benchmarks" | "sessions", record: Record<string, JsonValue>): Promise<void> {
    const file = await this.readCollection(collection);
    if (collection === "benchmarks")
      file.records = file.records.filter((item) => item.id !== record.id);
    file.records.push(record);
    await atomicWrite(this.pathFor(collection), `${JSON.stringify(file)}\n`);
  }

  async list<T extends Record<string, JsonValue>>(collection: "benchmarks" | "sessions"): Promise<T[]> {
    if (collection === "sessions") return (await this.listManifests()) as unknown as T[];
    return (await this.readCollection(collection)).records as T[];
  }

  sessionPath(id: string): string {
    return path.join(this.config.sessionsDir, `${id}.ndjson`);
  }

  async createSessionWriter(id: string): Promise<StreamingSessionWriter> {
    const filePath = this.sessionPath(id);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    return NdjsonSessionWriter.open(filePath);
  }

  async writeManifest(record: SessionRecord): Promise<void> {
    const manifests = await this.readManifests();
    manifests[record.id] = record;
    await atomicWrite(this.manifestsPath(), `${JSON.stringify(manifests)}\n`);
    await atomicWrite(this.manifestPath(record.id), `${JSON.stringify(record)}\n`);
  }

  async readManifest(id: string): Promise<SessionRecord | undefined> {
    try {
      return JSON.parse(await fs.readFile(this.manifestPath(id), "utf8")) as SessionRecord;
    } catch {
      return (await this.readManifests())[id];
    }
  }

  async listManifests(): Promise<SessionRecord[]> {
    return Object.values(await this.readManifests()).sort((a, b) =>
      String(b.startedAt).localeCompare(String(a.startedAt)));
  }

  async recoverIncompleteSessions(): Promise<SessionRecord[]> {
    const recovered: SessionRecord[] = [];
    for (const manifest of await this.listManifests()) {
      if (manifest.complete) continue;
      let content = "";
      try { content = await fs.readFile(this.sessionPath(manifest.id), "utf8"); } catch { continue; }
      const handle = await fs.open(this.sessionPath(manifest.id), "a", 0o600);
      try {
        if (!content.endsWith("\n")) await handle.writeFile("\n");
        const eventCount = content.split("\n").filter(Boolean).length + (content.endsWith("\n") ? 0 : 1);
        const updated: SessionRecord = {
          ...manifest,
          status: "incomplete",
          complete: true,
          recoveredAt: new Date().toISOString(),
          eventCount,
        };
        await handle.writeFile(`${JSON.stringify({
          id: eventId(), timestamp: new Date().toISOString(), sequence: eventCount,
          kind: "session.recovered", data: { reason: "startup-recovery", observedEventCount: eventCount },
        })}\n`);
        await this.writeManifest(updated);
        recovered.push(updated);
      } finally {
        await handle.sync();
        await handle.close();
      }
    }
    return recovered;
  }

  exportPath(id: string): string {
    return path.join(this.config.exportsDir, id.endsWith(".json") ? id : `${id}.json`);
  }

  pathFor(collection: string): string {
    return path.join(this.config.databasePath, `${collection}.json`);
  }

  private manifestPath(id: string): string {
    return path.join(this.config.sessionsDir, `${id}.manifest.json`);
  }

  private manifestsPath(): string {
    return path.join(this.config.databasePath, "session-manifests.json");
  }

  private async readCollection(collection: "benchmarks" | "sessions"): Promise<StoreFile> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.pathFor(collection), "utf8")) as StoreFile;
      if ((parsed.schemaVersion !== 1 && parsed.schemaVersion !== 2) || !Array.isArray(parsed.records)) throw new Error("invalid");
      return parsed;
    } catch {
      return { schemaVersion: 2, records: [] };
    }
  }

  private async readManifests(): Promise<Record<string, SessionRecord>> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.manifestsPath(), "utf8")) as Record<string, SessionRecord>;
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }
}

async function migrate(databasePath: string): Promise<void> {
  await fs.mkdir(databasePath, { recursive: true });
  await atomicWrite(path.join(databasePath, "schema.json"), `${JSON.stringify({ version: 2 })}\n`);
}

async function atomicWrite(filePath: string, content: string): Promise<void> {
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const handle = await fs.open(temporary, "w", 0o600);
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(temporary, filePath);
}

function eventId(): string {
  return crypto.randomUUID();
}
