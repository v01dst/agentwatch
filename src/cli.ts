#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { AgentRunner } from "./observability/runner.js";
import { LocalStore } from "./storage/store.js";
import { analyzeEvents, scanProject } from "./analysis/security.js";
import { scoreCandidates } from "./benchmark/engine.js";
import type { BenchmarkRunResult } from "./benchmark/types.js";
import { comparisonReport } from "./report/render.js";

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
    };
    const childArgv = rest.slice(rest.indexOf("--") + 1).filter(Boolean);
    const run = await new AgentRunner().run(childArgv, runnerOptions);
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
    const payload = { id, findings, eventCount: events.length, events };
    if (command !== "report" || args.flags.has("json")) console.log(JSON.stringify(payload, null, 2));
    else printSession(events, findings);
    return 0;
  }
  if (command === "benchmark") {
    const args = parseArgs(rest);
    const taskDir = path.resolve(args.positional[0] ?? ".");
    const agents = Array.isArray(args.flags.get("agent")) ? [] : collectAgents(args.flags.get("agent"));
    const results: BenchmarkRunResult[] = [];
    for (const [agentId, model] of agents) {
      const run = await new AgentRunner().run([agentId], {
        cwd: taskDir,
        ...(model === undefined ? {} : { model }),
      });
      results.push(candidateFromRun(run, agentId, model));
    }
    const scored = scoreCandidates(results);
    const resultPath = path.join(taskDir, ".agentwatch-result.json");
    await fs.writeFile(resultPath, JSON.stringify({ task: path.basename(taskDir), candidates: scored }, null, 2), { mode: 0o600 });
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
    console.log(JSON.stringify(await store.list("sessions"), null, 2));
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

main(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
}).catch((error: unknown) => {
  console.error(`AgentWatch: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
