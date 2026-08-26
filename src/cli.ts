#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { AgentRunner, type RunResult } from "./observability/runner.js";
import { LocalStore } from "./storage/store.js";
import { analyzeEvents, scanProject } from "./analysis/security.js";
import { scoreCandidates } from "./benchmark/engine.js";
import type { BenchmarkRunResult } from "./benchmark/types.js";
import type { JsonValue } from "./types.js";
import { comparisonReport } from "./report/render.js";
import { buildLeaderboard, renderDashboard } from "./observability/dashboard.js";
import { TerminalTui } from "./observability/tui.js";

interface ParsedArgs {
  flags: Map<string, string | boolean>;
  positional: string[];
}

function parseArgs(input: string[]): ParsedArgs {
  const flags = new Map<string, string | boolean>();
  const positional: string[] = [];
  let afterSeparator = false;
  for (let index = 0; index < input.length; index++) {
    const argument = input[index]!;
    if (afterSeparator || !argument.startsWith("--")) {
      positional.push(argument);
      continue;
    }
    if (argument === "--") {
      afterSeparator = true;
      continue;
    }
    const equalsIndex = argument.indexOf("=");
    if (equalsIndex > 2) {
      flags.set(argument.slice(2, equalsIndex), argument.slice(equalsIndex + 1));
      continue;
    }
    const next = input[index + 1];
    if (!next || next.startsWith("--")) flags.set(argument.slice(2), true);
    else {
      flags.set(argument.slice(2), next);
      index++;
    }
  }
  return { flags, positional };
}

const HELP = `AgentWatch — watch what your coding agent actually does.

Everything is local. AgentWatch observes and reports only: it never approves, blocks,
pauses, edits, or controls the agent. Stop an agent normally with Ctrl+C.

USAGE
  agentwatch run [options] -- <agent-command> [arguments...]
      Run any CLI agent under observation.

      Examples:
        agentwatch run -- codex "fix the failing tests"
        agentwatch run --model claude-sonnet-4 -- claude
        agentwatch run --json -- node ./my-agent.js

  agentwatch tui [--interval-ms 1000]
      Open a full-screen local dashboard. Press 1-4 to switch tabs, r refresh, q quit.

  agentwatch dashboard
      Print one read-only dashboard snapshot.

  agentwatch session <id> [--json]
      Show the recorded event timeline for one session.

  agentwatch report <id> [--json]
      Summarize lifecycle, activity, resources, files, git, tokens, and findings.

  agentwatch inspect <id>
      Machine-readable session payload (same as report --json).

  agentwatch benchmark <task-dir> --agent name[:model]
      Run reproducible deterministic comparisons.

      Example:
        agentwatch benchmark ./examples/benchmark-tasks/calculate-cli --agent codex:gpt-5

  agentwatch compare result-a.json result-b.json
      Compare two saved benchmark results and explain exactly why one won.

  agentwatch leaderboard [--task id] [--limit n] [--json]
      Aggregate local historical benchmark results by agent/model.

  agentwatch history [--json]
      List recorded sessions.

  agentwatch export <file-or-session-id>
  agentwatch import <export-file>
      Copy artifacts between local project data directories.

COMMON RUN OPTIONS
  --adapter <name>              Prefer codex, claude, opencode, or generic.
  --model <model>               Expose AGENTWATCH_MODEL to the child process.
  --json                        Machine-readable output where supported.
  --no-process-tree             Disable best-effort descendant-process snapshots.
  --no-network                  Disable metadata-only network snapshots.
  --resource-interval-ms <ms>   Sampling interval; 0 disables resource sampling.

DATA
  Stored locally in ./.agentwatch by default.
  Override with AGENTWATCH_DATA_DIR=/path/to/local/directory.

SECURITY NOTE
  Findings are informational only. Potential secrets are redacted in output.`;

async function main(argv: string[]): Promise<number> {
  const command = argv[0];
  if (!command || command === "help" || argv.includes("--help")) {
    console.log(HELP);
    return 0;
  }
  const rest = argv.slice(1);
  const store = await LocalStore.open();
  if (command === "run") {
    const args = parseArgs(rest);
    const childArguments = rest[rest.indexOf("--") + 1];
    if (!childArguments) throw new Error("run requires: agentwatch run -- <command>");
    const runnerOptions = {
      cwd: process.cwd(),
      ...(typeof args.flags.get("model") === "string" ? { model: String(args.flags.get("model")) } : {}),
      processTree: !args.flags.has("no-process-tree"),
      network: !args.flags.has("no-network"),
      ...(Number(args.flags.get("resource-interval-ms")) > 0 ? { resourceIntervalMs: Number(args.flags.get("resource-interval-ms")) } : {}),
    };
    const childArgv = rest.slice(rest.indexOf("--") + 1).filter(Boolean);
    const overlayEnabled = !args.flags.has("no-overlay") && process.stdout.isTTY && !args.flags.has("json");
    const overlay = overlayEnabled ? createOverlay() : null;
    let completed: RunResult | undefined;
    try {
      completed = await (await AgentRunner.open({ cwd: process.cwd() })).run(childArgv, {
        ...runnerOptions,
        onEvent: async (event) => {
          overlay?.update(event);
        },
      });
    } finally {
      overlay?.finish(completed?.status ?? "failed", completed?.exitCode ?? null, completed?.durationMs ?? 0);
    }
    if (completed && args.flags.has("json")) console.log(JSON.stringify({ ...completed, status: completed.status }, null, 2));
    return 0;
  }
  if (command === "tui") {
    const intervalMs = Number(parseArgs(rest).flags.get("interval-ms") ?? 1000);
    const tui = await TerminalTui.launch(Number.isFinite(intervalMs) && intervalMs >= 250 ? intervalMs : 1000);
    tui.start();
    return new Promise<number>((resolve) => {
      process.once("SIGINT", () => { tui.quit(); resolve(0); });
      const wait = setInterval(() => {
        if (!isTuiRunning(tui)) {
          clearInterval(wait);
          resolve(0);
        }
      }, 100);
      wait.unref();
    });
  }
  if (command === "dashboard") {
    console.log(await renderDashboard(store));
    return 0;
  }
  if (command === "session" || command === "inspect" || command === "report") {
    const args = parseArgs(rest);
    const id = args.positional[0];
    if (!id) throw new Error(`${command} requires a session id`);
    const raw = await fs.readFile(store.sessionPath(id), "utf8");
    const events = raw.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    const findings = [...analyzeEvents(events), ...(await scanProject(process.cwd()))];
    const manifest = await store.readManifest(id);
    const payload = { id, manifest, findings, eventCount: events.length, events };
    if (command === "session" && args.flags.has("json")) console.log(JSON.stringify(payload, null, 2));
    else if (command === "inspect") console.log(JSON.stringify(payload, null, 2));
    else if (command === "report") printRichReport(manifest, events, findings);
    else printSession(events, findings);
    return 0;
  }
  if (command === "benchmark") {
    const args = parseArgs(rest);
    const taskDir = path.resolve(args.positional[0] ?? ".");
    const agents = Array.isArray(args.flags.get("agent")) ? [] : collectAgents(args.flags.get("agent"));
    const results: BenchmarkRunResult[] = [];
    for (const [agentId, model] of agents) {
      const run = await (await AgentRunner.open({ cwd: taskDir })).run([agentId], {
        cwd: taskDir,
        ...(model === undefined ? {} : { model }),
        processTree: !args.flags.has("no-process-tree"),
        network: !args.flags.has("no-network"),
        ...(Number(args.flags.get("resource-interval-ms")) > 0 ? { resourceIntervalMs: Number(args.flags.get("resource-interval-ms")) } : {}),
      });
      results.push(candidateFromRun(run, agentId, model));
    }
    const scored = scoreCandidates(results);
    const resultPath = path.join(taskDir, ".agentwatch-result.json");
    const result = {
      schemaVersion: 2,
      id: `${path.basename(taskDir)}-${Date.now()}`,
      task: path.basename(taskDir),
      createdAt: new Date().toISOString(),
      candidates: scored,
    };
    await fs.writeFile(resultPath, JSON.stringify(result, null, 2), { mode: 0o600 });
    await store.append("benchmarks", JSON.parse(JSON.stringify(result)) as Record<string, JsonValue>);
    if (scored.length >= 2) {
      console.log(comparisonReport(scored[0]!, scored[1]!, path.basename(taskDir), [
        results[0]!.agentId, results[1]!.agentId,
      ]));
    } else console.log(JSON.stringify(scored, null, 2));
    console.log(`\nResult saved to ${resultPath}`);
    return 0;
  }
  if (command === "compare") {
    const left = JSON.parse(await fs.readFile(path.resolve(rest[0]!), "utf8"));
    const right = JSON.parse(await fs.readFile(path.resolve(rest[1]!), "utf8"));
    console.log(comparisonReport(left.candidates[0], right.candidates[0], left.task, [left.task, right.task]));
    return 0;
  }
  if (command === "history") {
    const args = parseArgs(rest);
    const sessions = await store.listManifests();
    if (args.flags.has("json")) console.log(JSON.stringify(sessions, null, 2));
    else for (const session of sessions)
      console.log(`${session.status.padEnd(10)} ${session.id} ${redactCliText(session.command.join(" "))}`);
    return 0;
  }
  if (command === "leaderboard") {
    const args = parseArgs(rest);
    const entries = await buildLeaderboard(store, typeof args.flags.get("task") === "string" ? String(args.flags.get("task")) : undefined);
    const limit = Number(args.flags.get("limit") ?? (entries.length || 10));
    const visible = entries.slice(0, Number.isFinite(limit) && limit > 0 ? limit : 10);
    if (args.flags.has("json")) console.log(JSON.stringify(visible, null, 2));
    else {
      console.log("Local benchmark leaderboard (task-specific; not universal rankings)\n");
      for (const [index, entry] of visible.entries())
        console.log(`${String(index + 1).padStart(2)}. ${entry.agent}${entry.model ? `:${entry.model}` : ""} — score ${entry.averageScore}, wins ${entry.wins}/${entry.runs}, pass rate ${Math.round(entry.averageTestPassRate * 100)}%${entry.medianDurationMs == null ? "" : `, median ${entry.medianDurationMs} ms`}`);
    }
    return 0;
  }
  if (command === "export" || command === "import") {
    const source = rest[0];
    if (!source) throw new Error(`${command} requires a file`);
    const target = store.exportPath(command === "import" ? path.basename(source) : source);
    await fs.copyFile(source, target);
    console.log(target);
    return 0;
  }
  throw new Error(`Unknown command: ${command}. Run agentwatch --help.`);
}

function collectAgents(value: string | boolean | undefined): Array<[string, string | undefined]> {
  const raw = typeof value === "string" ? value : "";
  return raw ? [[raw.split(":")[0]!, raw.includes(":") ? raw.split(":")[1] : undefined]] : [];
}

function candidateFromRun(run: any, agentId: string, model?: string): BenchmarkRunResult {
  const text = `${run.stdout}\n${run.stderr}`;
  const passed = /(\d+)\s+(?:tests?\s+)?pass(?:ed)?/i.exec(text)?.[1];
  const failed = /(\d+)\s+(?:tests?\s+)?fail(?:ed)?/i.exec(text)?.[1];
  return {
    agentId,
    ...(model ? { model } : {}),
    passedTests: passed ? Number(passed) : 0,
    failedTests: failed ? Number(failed) : 0,
    buildSucceeded: run.exitCode === 0,
    durationMs: run.durationMs,
    errorCount: (text.match(/\berror\b/gi) ?? []).length,
    filesChanged: run.events.filter((event: any) => event.kind === "file.change").length,
    securityFindings: analyzeEvents(run.events).length,
    ...(run.tokenUsage?.input != null ? { inputTokens: run.tokenUsage.input } : {}),
    ...(run.tokenUsage?.output != null ? { outputTokens: run.tokenUsage.output } : {}),
  };
}

function printSession(events: any[], findings: unknown[]): void {
  for (const event of events)
    console.log(`${String(event.sequence).padStart(4)}  ${event.kind}  ${JSON.stringify(event.data)}`);
  console.log(`\nSecurity findings: ${findings.length}`);
}

function printRichReport(manifest: any, events: any[], findings: unknown[]): void {
  console.log(`Session ${manifest?.id ?? "unknown"} — ${manifest?.status ?? "unknown"}`);
  console.log(`Command: ${manifest?.command?.join(" ") ?? "unknown"}`);
  console.log(`Adapter: ${manifest?.adapter ?? "unknown"} · Duration: ${manifest?.durationMs ?? "?"} ms · Exit: ${manifest?.exitCode ?? "?"}${manifest?.signal ? ` · Signal: ${manifest.signal}` : ""}`);
  const counts = new Map<string, number>();
  for (const event of events) counts.set(event.kind, (counts.get(event.kind) ?? 0) + 1);
  console.log("\nActivity:");
  for (const [kind, count] of [...counts.entries()].sort()) console.log(`- ${kind}: ${count}`);
  const resources = events.filter((event) => event.kind === "resource.usage").map((event) => Number(event.data.rssBytes));
  if (resources.length) console.log(`Resource peak RSS: ${(Math.max(...resources) / 1024 / 1024).toFixed(1)} MB`);
  console.log("\nSecurity findings:");
  if (!findings.length) console.log("- none detected");
  for (const finding of findings as any[]) console.log(`- [${finding.severity}] ${finding.title}${finding.filePath ? ` — ${finding.filePath}` : ""}`);
}

function redactCliText(value: string): string {
  return value.replace(/(?:api[_-]?key|token|password|secret)["':=\s]+[^\s'"]+/gi, "$&…[redacted]");
}

interface LiveOverlay {
  update(event: { kind: string; data: Record<string, unknown> }): void;
  finish(status: "success" | "failed" | "signaled" | string | undefined, exitCode: number | null, durationMs: number): void;
}

function createOverlay(): LiveOverlay {
  const startedAt = Date.now();
  let events = 0;
  let files = 0;
  let findings = 0;
  let lastActivity = "";
  let lastResourceMb = 0;
  const render = () => {
    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
    const activity = lastActivity.slice(0, Math.max(12, (process.stdout.columns ?? 100) - 58));
    process.stdout.write(`\u001b[s\r\u001b[K\u001b[90mAgentWatch · ${elapsed}s · ${events} events · ${files} files · ${findings} findings${lastResourceMb ? ` · ${lastResourceMb.toFixed(1)} MB` : ""}${activity ? ` · ${activity}` : ""}\u001b[0m\u001b[u`);
  };
  render();
  return {
    update(event) {
      events++;
      if (event.kind === "file.change") files++;
      if (event.kind === "security.finding") findings++;
      if (event.kind === "resource.usage") lastResourceMb = Number(event.data.rssBytes ?? 0) / 1024 / 1024;
      if (event.kind === "output.stdout") lastActivity = `stdout ${String(event.data.line ?? "").slice(0, 80)}`;
      else if (event.kind === "output.stderr") lastActivity = `stderr ${String(event.data.line ?? "").slice(0, 80)}`;
      else if (event.kind === "process.tree") lastActivity = `process ${String(event.data.pid ?? "")}`;
      render();
    },
    finish(status, exitCode, durationMs) {
      process.stdout.write(`\n\u001b[90mAgentWatch finished · ${status ?? "unknown"} · exit ${exitCode ?? "?"} · ${(durationMs / 1000).toFixed(1)}s\u001b[0m\n`);
    },
  };
}

function isTuiRunning(tui: TerminalTui): boolean {
  return tui.isRunning();
}

main(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
}).catch((error: unknown) => {
  console.error(`AgentWatch: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
