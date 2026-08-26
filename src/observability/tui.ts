import readline from "node:readline";
import process from "node:process";
import { LocalStore } from "../storage/store.js";
import { analyzeEvents, scanProject } from "../analysis/security.js";
import { buildLeaderboard } from "./dashboard.js";

type Tab = "overview" | "sessions" | "security" | "benchmarks";

interface TuiOptions {
  intervalMs?: number;
}

interface SessionRow {
  id: string;
  status: string;
  adapter: string;
  durationMs?: number;
  exitCode?: number | null;
}

export class TerminalTui {
  private readonly store: LocalStore;
  private readonly rl: readline.Interface;
  private timer?: NodeJS.Timeout;
  private tab: Tab = "overview";
  private running = true;
  private frame = "";
  private loading = false;

  constructor(store: LocalStore, private readonly options: TuiOptions = {}) {
    this.store = store;
    this.rl = readline.createInterface({ input: process.stdin, terminal: process.stdin.isTTY ?? false });
    this.rl.on("line", (line) => this.handleInput(line.trim().toLowerCase()));
    this.rl.on("SIGINT", () => this.quit());
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
      process.stdin.resume();
    }
  }

  static async launch(intervalMs = 1000): Promise<TerminalTui> {
    return new TerminalTui(await LocalStore.open(), { intervalMs });
  }

  start(): void {
    process.stdout.write("\u001b[?1049h\u001b[?25l");
    process.on("resize", () => { void this.refresh(); });
    void this.refresh();
    this.timer = setInterval(() => { void this.refresh(); }, Math.max(250, this.options.intervalMs ?? 1000));
    this.timer.unref();
  }

  async refresh(): Promise<void> {
    if (this.loading || !this.running) return;
    this.loading = true;
    try {
      this.frame = await this.render();
      process.stdout.write(`\u001b[H\u001b[2J${this.frame}`);
    } finally {
      this.loading = false;
    }
  }

  handleInput(input: string): void {
    if (input === "q" || input === "quit" || input === "exit") this.quit();
    else if (input === "1" || input === "o") this.tab = "overview";
    else if (input === "2" || input === "s") this.tab = "sessions";
    else if (input === "3" || input === "f") this.tab = "security";
    else if (input === "4" || input === "b") this.tab = "benchmarks";
    else if (input === "r") void this.refresh();
  }

  quit(): void {
    if (!this.running) return;
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.rl.close();
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdout.write("\u001b[?25h\u001b[?1049l");
    process.exitCode = 0;
  }

  isRunning(): boolean {
    return this.running;
  }

  private async render(): Promise<string> {
    const width = Math.max(60, process.stdout.columns ?? 100);
    const height = Math.max(18, process.stdout.rows ?? 28);
    const body = await this.renderTab(width, height - 6);
    const tabs = ["overview", "sessions", "security", "benchmarks"].map((tab, index) =>
      `${index + 1} ${tab}${this.tab === tab ? " ●" : ""}`).join("   ");
    return [
      `\u001b[96;1m AgentWatch Local TUI \u001b[0m\u001b[90m observe only · local data · q quit · r refresh · 1-4 tabs \u001b[0m`,
      `\u001b[90m${"─".repeat(width)}\u001b[0m`,
      body,
      `\u001b[90m${"─".repeat(width)}\u001b[0m`,
      ` ${tabs}`,
      "",
    ].join("\n");
  }

  private async renderTab(width: number, height: number): Promise<string> {
    if (this.tab === "sessions") {
      const sessions = (await this.store.listManifests()).slice(0, height);
      const rows: string[] = [];
      for (const session of sessions as SessionRow[]) {
        rows.push(`${session.status.padEnd(10)} ${session.id.padEnd(24)} ${(session.adapter ?? "").padEnd(10)} ${String(session.durationMs ?? "?").padStart(8)}ms`);
      }
      return rows.join("\n") || dim("No sessions recorded yet.");
    }
    if (this.tab === "benchmarks") {
      const entries = (await buildLeaderboard(this.store)).slice(0, height);
      return entries.map((entry, index) => `${String(index + 1).padStart(2)}. ${entry.agent}:${entry.model ?? "-"} score=${entry.averageScore} wins=${entry.wins}/${entry.runs} pass=${percent(entry.averageTestPassRate)}`).join("\n")
        || dim("Run agentwatch benchmark to create local results.");
    }
    if (this.tab === "security") {
      const findings = [...analyzeEvents([]), ...(await scanProject(process.cwd()))].slice(0, height);
      return findings.map((finding) => `${finding.severity === "critical" ? "!" : "-"} ${finding.title}${finding.filePath ? ` — ${finding.filePath}` : ""}`).join("\n")
        || dim("No security findings detected.");
    }
    const manifests = await this.store.listManifests();
    const latest = manifests[0];
    const benchmarks = await buildLeaderboard(this.store, undefined).catch(() => []);
    const lines = [
      bold("Latest session"),
      latest ? `${latest.status} · ${latest.adapter} · ${latest.durationMs ?? "?"} ms` : dim("none"),
      "",
      bold("Totals"),
      `sessions ${manifests.length} · benchmark agents ${benchmarks.length}`,
      "",
      bold("Recent activity"),
      ...manifests.slice(0, Math.max(1, height - 7)).map((session: any) => `${session.status === "success" ? green("✔") : session.status === "failed" ? red("✘") : yellow("•")} ${session.id}`),
      "",
      dim("AgentWatch records locally. It does not block or control your agent."),
    ];
    return lines.join("\n").split("\n").slice(0, height).join("\n");
  }
}

function bold(value: string): string { return `\u001b[1m${value}\u001b[0m`; }
function dim(value: string): string { return `\u001b[90m${value}\u001b[0m`; }
function green(value: string): string { return `\u001b[32m${value}\u001b[0m`; }
function red(value: string): string { return `\u001b[31m${value}\u001b[0m`; }
function yellow(value: string): string { return `\u001b[33m${value}\u001b[0m`; }
function percent(value: number): string { return `${Math.round(value * 100)}%`; }
