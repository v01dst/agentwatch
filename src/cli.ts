#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { AgentRunner } from "./observability/runner.js";
import { LocalStore } from "./storage/store.js";
import { analyzeEvents, scanProject } from "./analysis/security.js";
import { scoreCandidates } from "./benchmark/engine.js";
import type { BenchmarkRunResult } from "./benchmark/types.js";
import type { JsonValue } from "./types.js";
import { comparisonReport } from "./report/render.js";
import { buildLeaderboard, renderDashboard } from "./observability/dashboard.js";

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

const HELP = `AgentWatch — local-first agent observability

Usage:
  agentwatch run [--adapter name] [--model model] -- <agent-command> [args...]
  agentwatch session <session-id> [--json]
  agentwatch inspect <session-id> --json
  agentwatch report <session-id>
  agentwatch benchmark <task-dir> --agent name[:model]
  agentwatch compare <result-a.json> <result-b.json>
  agentwatch history
  agentwatch export <file-or-session-id>
  agentwatch import <export-file>
  agentwatch dashboard
  agentwatch leaderboard [--task id] [--limit n]

AgentWatch observes only. It never approves, blocks, pauses, or edits an agent.
All data remains in ./.agentwatch unless AGENTWATCH_DATA_DIR is configured.`;

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
    const run = await (await AgentRunner.open({ cwd: process.cwd() })).run(childArgv, runnerOptions);
    if (args.flags.has("json")) console.log(JSON.stringify(run, null, 2));
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
  if (command === "dashboard") {
    console.log(await renderDashboard(store));
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

main(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
}).catch((error: unknown) => {
  console.error(`AgentWatch: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
