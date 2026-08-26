import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import type { AgentWatchEvent } from "../types.js";
import type { SessionStatus } from "../types.js";
import { eventId, sessionId } from "../utils/id.js";
import { resolveAdapter, tokenUsage, type AgentAdapter } from "../adapters/base.js";
import { LocalStore } from "../storage/store.js";
import { resolveConfig } from "../config/index.js";

export interface RunOptions {
  cwd?: string;
  model?: string;
  dataDirectory?: string;
  processTree?: boolean;
  network?: boolean;
  resourceIntervalMs?: number;
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
  status?: SessionStatus;
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
    this.store = store ?? new LocalStore(resolveConfig(process.cwd(), process.env.AGENTWATCH_DATA_DIR));
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
    const writer = await this.store.createSessionWriter(id);
    await this.store.writeManifest({
      schemaVersion: 2, id, startedAt: new Date().toISOString(), command: argv,
      cwd, adapter: adapter.name, status: "running", complete: false,
    });

    const emit = async (kind: AgentWatchEvent["kind"], data: Record<string, unknown>, severity?: AgentWatchEvent["severity"]): Promise<void> => {
      const event: AgentWatchEvent = {
        id: eventId(), timestamp: new Date().toISOString(), sequence: sequence++, kind,
        ...(severity ? { severity } : {}), data: data as AgentWatchEvent["data"],
      };
      events.push(event);
      await writer.write(event);
      await options.onEvent?.(event);
    };

    const appendOutput = async (stream: "stdout" | "stderr", chunk: string): Promise<void> => {
      if (stream === "stdout") stdoutBuffer = boundedAppend(stdoutBuffer, chunk);
      else stderrBuffer = boundedAppend(stderrBuffer, chunk);
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

    const forwarder = createForwarder(child.stdout!, "output.stdout", appendOutput.bind(null, "stdout"), emit);
    const errorForwarder = createForwarder(child.stderr!, "output.stderr", appendOutput.bind(null, "stderr"), emit);
    const interval = options.resourceIntervalMs ?? 1000;
    const resourceTimer = interval > 0 ? setInterval(() => {
      void emit("resource.usage", {
        rssBytes: process.memoryUsage.rss(),
        cpuUserMs: process.cpuUsage().user,
        cpuSystemMs: process.cpuUsage().system,
        childPid: child.pid,
      });
    }, interval) : null;
    const observers: Array<{ stop(): void }> = [];
    if (options.processTree !== false) {
      const processObserver = new ProcessTreeObserver();
      processObserver.start(Number(child.pid ?? 0), (snapshot) => { void emit("process.tree", snapshot); }, interval);
      observers.push(processObserver);
    }
    if (options.network !== false) {
      const networkObserver = new NetworkObserver();
      networkObserver.start(Number(child.pid ?? 0), (connections) => { void emit("network.observation.detail", { connections }); }, Math.max(interval, 2000));
      observers.push(networkObserver);
    }
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
    if (resourceTimer) clearInterval(resourceTimer);
    for (const observer of observers) observer.stop();
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
    const status: SessionStatus = result.signal ? "signaled" : result.exitCode === 0 ? "success" : "failed";
    await emit("session.end", {
      exitCode: result.exitCode, signal: result.signal, durationMs, status,
      command: argv, cwd, adapter: adapter.name, tokenUsage: usage,
    });
    await this.store.writeManifest({
      schemaVersion: 2, id, startedAt: new Date(startedAt).toISOString(), endedAt: new Date().toISOString(),
      exitCode: result.exitCode, signal: result.signal, durationMs, command: argv, cwd,
      adapter: adapter.name, status, ...(child.pid === undefined ? {} : { pid: child.pid }), eventCount: events.length, complete: true,
    });
    await writer.close();
    return {
      id, exitCode: result.exitCode, signal: result.signal, durationMs,
      events, stdout: redactText(stdoutBuffer), stderr: redactText(stderrBuffer),
      status,
      ...(Object.keys(usage).length > 0 ? { tokenUsage: usage } : {}),
    };
  }

}

function boundedAppend(current: string, chunk: string): string {
  const next = `${current}${chunk}\n`;
  return next.length > 256 * 1024 ? next.slice(next.length - 256 * 1024) : next;
}

interface Stoppable {
  stop(): void;
}

export class ProcessTreeObserver implements Stoppable {
  private timer?: NodeJS.Timeout;
  private readonly seen = new Set<number>();

  start(parentPid: number, callback: (data: Record<string, unknown>) => void, intervalMs = 1000): void {
    if (!parentPid) return;
    this.timer = setInterval(() => {
      void listDescendants(parentPid).then((snapshots) => {
        for (const snapshot of snapshots)
          callback({ ...snapshot, ...(this.seen.has(Number(snapshot.pid)) ? { lastSeenAt: new Date().toISOString() } : { firstSeenAt: new Date().toISOString() }) });
      }).catch(() => undefined);
    }, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }
}

interface ProcessLine { pid: number; ppid: number; command?: string; cpuPercent?: number; memoryBytes?: number }

async function listDescendants(parentPid: number): Promise<ProcessLine[]> {
  const all = process.platform === "darwin" ? await psSnapshot() : await procSnapshot();
  const byParent = new Map<number, ProcessLine[]>();
  for (const item of all) byParent.set(item.ppid, [...(byParent.get(item.ppid) ?? []), item]);
  const descendants: ProcessLine[] = [];
  const visit = (pid: number) => {
    for (const child of byParent.get(pid) ?? []) {
      descendants.push(child);
      visit(child.pid);
    }
  };
  visit(parentPid);
  return descendants;
}

async function psSnapshot(): Promise<ProcessLine[]> {
  const output = await execFileText("ps", ["-axo", "pid=,ppid=,%cpu=,rss=,command="]);
  return output.trim().split("\n").filter(Boolean).map((line) => {
    const columns = line.trim().split(/\s+/);
    return {
      pid: Number(columns[0]), ppid: Number(columns[1]), cpuPercent: Number(columns[2]),
      memoryBytes: Number(columns[3]) * 1024, command: redactText(columns.slice(4).join(" ")),
    };
  }).filter((item) => Number.isFinite(item.pid) && Number.isFinite(item.ppid));
}

async function procSnapshot(): Promise<ProcessLine[]> {
  const base = "/proc";
  const entries = await fs.readdir(base).catch(() => [] as string[]);
  const results: Array<ProcessLine | null> = await Promise.all(entries.filter((entry) => /^\d+$/.test(entry)).map(async (entry) => {
    try {
      const stat = await fs.readFile(path.join(base, entry, "stat"), "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      const command = redactText((await fs.readFile(path.join(base, entry, "cmdline"), "utf8")).replaceAll("\0", " ").trim());
      return { pid: Number(entry), ppid: Number(fields[1]), command, memoryBytes: Number(fields[21]) * 1024 };
    } catch { return null; }
  }));
  return results.filter((item): item is ProcessLine => item !== null && Number.isFinite(item.ppid));
}

async function execFileText(command: string, args: string[]): Promise<string> {
  const child = spawn(command, args);
  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => { output += String(chunk); });
  child.stderr?.resume();
  await new Promise<void>((resolve) => { child.once("close", resolve); child.once("error", resolve); });
  return output;
}

export class NetworkObserver implements Stoppable {
  private timer?: NodeJS.Timeout;

  start(_parentPid: number, callback: (connections: Array<Record<string, unknown>>) => void, intervalMs = 2000): void {
    this.timer = setInterval(() => {
      const tool = process.platform === "linux" ? "ss" : process.platform === "darwin" ? "lsof" : null;
      if (!tool) return;
      void execFileText(tool, tool === "ss" ? ["-tupn"] : ["-i", "-nP"]).then((output) =>
        callback(output.trim().split("\n").slice(1).filter(Boolean).map((line) => ({ raw: redactText(line) }))));
    }, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }
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
