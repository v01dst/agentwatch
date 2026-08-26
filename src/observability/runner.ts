import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import type { AgentWatchEvent } from "../types.js";
import { eventId, sessionId } from "../utils/id.js";
import { resolveAdapter, tokenUsage, type AgentAdapter } from "../adapters/base.js";
import { LocalStore } from "../storage/store.js";
import { resolveConfig } from "../config/index.js";

export interface RunOptions {
  cwd?: string;
  model?: string;
  dataDirectory?: string;
  onEvent?: (event: AgentWatchEvent) => void | Promise<void>;
}

export interface RunResult {
  id: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  durationMs: number;
  events: AgentWatchEvent[];
  stdout: string;
  stderr: string;
  tokenUsage?: { input?: number; output?: number };
}

interface SpawnedProcess {
  pid?: number | null;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  promise: Promise<void>;
}

export class AgentRunner {
  private readonly store: LocalStore;

  constructor(store?: LocalStore) {
    this.store = store ?? resolveConfiguredStore();
  }

  static async open(options: Pick<RunOptions, "cwd" | "dataDirectory"> = {}): Promise<AgentRunner> {
    return new AgentRunner(await LocalStore.open(options.cwd ?? process.cwd(), options.dataDirectory));
  }

  async run(argv: string[], options: RunOptions = {}): Promise<RunResult> {
    const cwd = options.cwd ?? process.cwd();
    const resolved = resolveAdapter(argv);
    const adapter: AgentAdapter = resolved.adapter;
    const launch = adapter.launch(resolved.argv, {
      cwd,
      ...(options.model === undefined ? {} : { model: options.model }),
    });
    const id = sessionId();
    let sequence = 0;
    const events: AgentWatchEvent[] = [];
    const startedAt = Date.now();
    let stdoutBuffer = "";
    let stderrBuffer = "";

    const emit = async (kind: AgentWatchEvent["kind"], data: Record<string, unknown>, severity?: AgentWatchEvent["severity"]): Promise<void> => {
      const event: AgentWatchEvent = {
        id: eventId(), timestamp: new Date().toISOString(), sequence: sequence++, kind,
        ...(severity ? { severity } : {}), data: data as AgentWatchEvent["data"],
      };
      events.push(event);
      await options.onEvent?.(event);
    };

    await emit("session.start", { command: argv, cwd, adapter: adapter.name });
    const before = await snapshotGit(cwd);
    const beforeFiles = await walkFiles(cwd).catch(() => new Map<string, number>());
    const child = spawn(launch.command, launch.args, {
      ...launch.spawnOptions,
      cwd,
      env: { ...process.env, ...(options.model ? { AGENTWATCH_MODEL: options.model } : {}) },
      stdio: ["pipe", "pipe", "pipe"],
    });
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.pipe(child.stdin, { end: false });
    process.stdin.resume();

    const forwarder = createForwarder(child.stdout!, "output.stdout", async (chunk) => {
      stdoutBuffer += chunk;
    }, emit);
    const errorForwarder = createForwarder(child.stderr!, "output.stderr", async (chunk) => {
      stderrBuffer += chunk;
    }, emit);
    const resourceTimer = setInterval(() => {
      void emit("resource.usage", {
        rssBytes: process.memoryUsage.rss(),
        cpuUserMs: process.cpuUsage().user,
        cpuSystemMs: process.cpuUsage().system,
        childPid: child.pid,
      });
    }, 1000);
    const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM"];
    const signalHandlers = new Map<NodeJS.Signals, () => void>();
    for (const signal of signals) {
      const handler = () => child.kill(signal);
      signalHandlers.set(signal, handler);
      process.once(signal, handler);
    }

    await emit("process.start", { pid: child.pid, command: [launch.command, ...launch.args] });
    const exited = new Promise<SpawnedProcess>((resolve) => {
      child.once("exit", (exitCode, signal) => resolve({ pid: child.pid ?? null, exitCode, signal, promise: Promise.resolve() }));
      child.once("error", (error) => {
        void emit("process.exit", { reason: error.message, exitCode: -1 });
        resolve({ pid: child.pid ?? null, exitCode: -1, signal: null, promise: Promise.resolve() });
      });
    });
    const result = await exited;
    clearInterval(resourceTimer);
    for (const [signal, handler] of signalHandlers) process.off(signal, handler);
    process.stdin.unpipe(child.stdin);
    if (process.stdin.isTTY && process.stdin.readable) process.stdin.setRawMode(false);
    process.stdin.pause();
    await Promise.allSettled([forwarder, errorForwarder]);

    const after = await snapshotGit(cwd);
    const afterFiles = await walkFiles(cwd).catch(() => new Map<string, number>());
    await emitFileDiffs(emit, beforeFiles, afterFiles);
    await emitGitChanges(emit, before, after);
    const usage = adapter.extractTokenUsage?.(stdoutBuffer, stderrBuffer) ?? tokenUsage(stdoutBuffer, stderrBuffer);
    if (Object.keys(usage).length > 0) await emit("adapter.custom", { type: "token-usage", ...usage });
    const durationMs = Date.now() - startedAt;
    const status = result.signal ? "signaled" : result.exitCode === 0 ? "success" : "failed";
    await emit("session.end", {
      exitCode: result.exitCode, signal: result.signal, durationMs, status,
      command: argv, cwd, adapter: adapter.name, tokenUsage: usage,
    });
    await this.persist(id, events);
    return {
      id, exitCode: result.exitCode, signal: result.signal, durationMs,
      events, stdout: redactText(stdoutBuffer), stderr: redactText(stderrBuffer),
      ...(Object.keys(usage).length > 0 ? { tokenUsage: usage } : {}),
    };
  }

  private async persist(id: string, events: AgentWatchEvent[]): Promise<void> {
    const filePath = path.join(this.store.sessionPath(id), "..", `${id}.ndjson`);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`, { mode: 0o600 });
    await this.store.append("sessions", { id, eventCount: events.length });
  }
}

function resolveConfiguredStore(): LocalStore {
  const config = resolveConfig(process.cwd(), process.env.AGENTWATCH_DATA_DIR);
  return new LocalStore(config);
}

function createForwarder(
  stream: NodeJS.ReadableStream,
  kind: AgentWatchEvent["kind"],
  append: (chunk: string) => Promise<void>,
  emit: (kind: AgentWatchEvent["kind"], data: Record<string, unknown>) => Promise<void>,
): Promise<void> {
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  lines.on("line", (line) => {
    process.stdout.write(`${line}\n`);
    void append(line).then(() => emit(kind, { line: redactText(line) }));
  });
  return new Promise((resolve, reject) => {
    lines.once("close", resolve);
    lines.once("error", reject);
  });
}

async function snapshotGit(cwd: string): Promise<{ status: string; diffStat: string }> {
  try {
    return {
      status: await runCapture(cwd, "git", ["status", "--porcelain"]),
      diffStat: await runCapture(cwd, "git", ["diff", "--shortstat"]),
    };
  } catch {
    return { status: "", diffStat: "" };
  }
}

async function runCapture(cwd: string, command: string, args: string[]): Promise<string> {
  const child = spawn(command, args, { cwd });
  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => { output += String(chunk); });
  await new Promise<void>((resolve, reject) => {
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`${command} failed`)));
    child.once("error", reject);
  });
  return output;
}

async function walkFiles(root: string): Promise<Map<string, number>> {
  const results = new Map<string, number>();
  const entries = await fs.readdir(root, { withFileTypes: true, recursive: false });
  for (const entry of entries) {
    if (entry.name === ".agentwatch" || entry.name === ".git") continue;
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) continue;
    const stat = await fs.stat(fullPath);
    results.set(path.relative(root, fullPath), stat.mtimeMs);
  }
  return results;
}

async function emitFileDiffs(
  emit: (kind: AgentWatchEvent["kind"], data: Record<string, unknown>) => Promise<void>,
  before: Map<string, number>,
  after: Map<string, number>,
): Promise<void> {
  for (const [file, mtime] of after)
    if (!before.has(file)) await emit("file.change", { file, change: "created", mtimeMs: mtime });
    else if (before.get(file) !== mtime) await emit("file.change", { file, change: "modified", mtimeMs: mtime });
  for (const file of before.keys())
    if (!after.has(file)) await emit("file.change", { file, change: "deleted" });
}

async function emitGitChanges(
  emit: (kind: AgentWatchEvent["kind"], data: Record<string, unknown>) => Promise<void>,
  before: { status: string },
  after: { status: string; diffStat: string },
): Promise<void> {
  if (before.status !== after.status || after.diffStat)
    await emit("git.change", { status: redactText(after.status), diffStat: redactText(after.diffStat) });
}

const secretPattern = /(?:api[_-]?key|token|password|secret)["':=\s]+[^\s'"]+/gi;
export function redactText(value: string): string {
  return value.replace(secretPattern, (match) =>
    /^(?:api[_-]?key|token|password|secret)["':=\s]+$/i.test(match) ? match : `${match.slice(0, Math.min(match.length, 8))}…[redacted]`);
}
