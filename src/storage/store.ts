import fs from "node:fs/promises";
import path from "node:path";
import type { JsonValue } from "../types.js";
import { resolveConfig, type ResolvedConfig } from "../config/index.js";

interface StoreFile {
  schemaVersion: number;
  records: Array<Record<string, JsonValue>>;
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
    file.records.push(record);
    await atomicWrite(this.pathFor(collection), `${JSON.stringify(file)}\n`);
  }

  async list<T extends Record<string, JsonValue>>(collection: "benchmarks" | "sessions"): Promise<T[]> {
    return (await this.readCollection(collection)).records as T[];
  }

  sessionPath(id: string): string {
    return path.join(this.config.sessionsDir, `${id}.ndjson`);
  }

  exportPath(id: string): string {
    return path.join(this.config.exportsDir, id.endsWith(".json") ? id : `${id}.json`);
  }

  private pathFor(collection: string): string {
    return path.join(this.config.databasePath, `${collection}.json`);
  }

  private async readCollection(collection: "benchmarks" | "sessions"): Promise<StoreFile> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.pathFor(collection), "utf8")) as StoreFile;
      if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.records)) throw new Error("invalid");
      return parsed;
    } catch {
      return { schemaVersion: 1, records: [] };
    }
  }
}

async function migrate(databasePath: string): Promise<void> {
  await fs.mkdir(databasePath, { recursive: true });
  await atomicWrite(path.join(databasePath, "schema.json"), `${JSON.stringify({ version: 1 })}\n`);
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
