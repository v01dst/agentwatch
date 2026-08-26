import { LocalStore, type SessionRecord } from "../storage/store.js";
import { resolveConfig } from "../config/index.js";
import { analyzeEvents, scanProject } from "../analysis/security.js";
import fs from "node:fs/promises";
import path from "node:path";

export interface LeaderboardEntry {
  agent: string;
  model?: string;
  runs: number;
  wins: number;
  averageScore: number;
  averageTestPassRate: number;
  medianDurationMs?: number;
  averageCommands?: number;
  averageErrors?: number;
  totalInputTokens?: number;
  totalOutputTokens?: number;
  averageSecurityFindings: number;
}

interface BenchmarkArtifact {
  id?: string;
  task: string;
  createdAt?: string;
  candidates: Array<{ score: number; candidate: Record<string, unknown> }>;
}

function ansi(code: string, text: string): string {
  return `\u001b[${code}m${text}\u001b[0m`;
}

export async function renderDashboard(store: LocalStore): Promise<string> {
  const sessions = (await store.listManifests()).slice(0, 8);
  const incomplete = sessions.filter((session) => !session.complete).length;
  const lines = [
    ansi("96;1", "AGENTWATCH LOCAL DASHBOARD"),
    `${ansi("90", "Sessions")} ${String(sessions.length).padStart(3)}   ${ansi("90", "Incomplete")} ${String(incomplete).padStart(2)}`,
    "",
    ansi("93", "Recent sessions"),
  ];
  for (const session of sessions) {
    const status = session.status === "success" ? ansi("32", "ok") : session.status === "failed" ? ansi("31", "fail") : session.status === "running" ? ansi("33", "run") : ansi("35", session.status);
    const command = redactText(session.command.join(" ")).slice(0, 58);
    lines.push(`${status}  ${session.id}  ${command}`);
    if (session.durationMs != null) lines.push(`     ${ansi("90", `duration ${session.durationMs} ms · exit ${session.exitCode ?? "?"}`)}`);
  }
  const benchmarks = await listBenchmarks();
  const latest = benchmarks[0];
  lines.push("", ansi("93", "Latest benchmark"), latest ? summarizeBenchmark(latest) : ansi("90", "No benchmark results yet"));
  const findings = [...analyzeEvents([]), ...(await scanProject(process.cwd()))];
  lines.push("", `${ansi("93", "Security findings")} ${findings.length}`);
  for (const finding of findings.slice(0, 5)) lines.push(`${finding.severity === "critical" ? ansi("31", "!") : ansi("33", "-")} ${finding.title}${finding.filePath ? ` · ${finding.filePath}` : ""}`);
  lines.push("", ansi("90", "Observe only. AgentWatch never blocks or controls your agent."));
  return lines.join("\n");
}

export async function buildLeaderboard(store: LocalStore, taskFilter?: string): Promise<LeaderboardEntry[]> {
  const records = await store.list("benchmarks");
  const artifacts = records.map((record) => record as unknown as BenchmarkArtifact).filter(isBenchmark)
    .filter((item) => !taskFilter || item.task === taskFilter);
  const groups = new Map<string, Array<{ score: number; candidate: Record<string, any>; won: boolean }>>();
  for (const artifact of artifacts) {
    const winnerScore = Math.max(...artifact.candidates.map((candidate) => candidate.score));
    for (const scored of artifact.candidates) {
      const key = `${scored.candidate.agentId}:${scored.candidate.model ?? ""}`;
      const group = groups.get(key) ?? [];
      group.push({ ...scored, won: scored.score === winnerScore });
      groups.set(key, group);
    }
  }
  const entries: LeaderboardEntry[] = [...groups.entries()].map(([key, runs]) => {
    const [agentId, model = ""] = key.split(":");
    const medianDuration = median(runs.map((run) => Number(run.candidate.durationMs)).filter(Number.isFinite));
    const averageCommands = optionalMean(runs.map((run) => Number(run.candidate.commandCount)));
    const averageErrors = optionalMean(runs.map((run) => Number(run.candidate.errorCount)));
    const totalInputTokens = optionalSum(runs.map((run) => Number(run.candidate.inputTokens)));
    const totalOutputTokens = optionalSum(runs.map((run) => Number(run.candidate.outputTokens)));
    return {
      agent: agentId ?? "unknown",
      ...(model ? { model } : {}),
      runs: runs.length,
      wins: runs.filter((run) => run.won).length,
      averageScore: mean(runs.map((run) => run.score)),
      averageTestPassRate: mean(runs.map((run) => testRate(run.candidate))),
      ...(medianDuration === undefined ? {} : { medianDurationMs: medianDuration as number }),
      ...(averageCommands === undefined ? {} : { averageCommands: averageCommands as number }),
      ...(averageErrors === undefined ? {} : { averageErrors: averageErrors as number }),
      ...(totalInputTokens === undefined ? {} : { totalInputTokens: totalInputTokens as number }),
      ...(totalOutputTokens === undefined ? {} : { totalOutputTokens: totalOutputTokens as number }),
      averageSecurityFindings: mean(runs.map((run) => Number(run.candidate.securityFindings ?? 0))),
    };
  }).sort((a, b) => b.averageScore - a.averageScore);
  return entries;
}

async function listBenchmarks(): Promise<BenchmarkArtifact[]> {
  const store = await LocalStore.open();
  const records = await store.list("benchmarks");
  return records.map((record) => record as unknown as BenchmarkArtifact).filter(isBenchmark)
    .sort((a, b) => String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")));
}

function isBenchmark(value: unknown): value is BenchmarkArtifact {
  const record = value as BenchmarkArtifact;
  return typeof record?.task === "string" && Array.isArray(record.candidates);
}

function redactText(value: string): string {
  return value.replace(/(?:api[_-]?key|token|password|secret)["':=\s]+[^\s'"]+/gi, "$&…[redacted]");
}

function summarizeBenchmark(benchmark: BenchmarkArtifact): string {
  const winner = benchmark.candidates[0];
  return winner ? `${benchmark.task}: ${winner.candidate.agentId} (${winner.score})` : benchmark.task;
}


function mean(values: number[]): number {
  return values.length ? Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(4)) : 0;
}
function optionalMean(values: number[]): number | undefined {
  const valid = values.filter(Number.isFinite);
  return valid.length ? mean(valid) : undefined;
}
function optionalSum(values: number[]): number | undefined {
  const valid = values.filter(Number.isFinite);
  return valid.length ? valid.reduce((sum, value) => sum + value, 0) : undefined;
}
function median(values: number[]): number | undefined {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}
function testRate(candidate: Record<string, any>): number {
  const passed = Number(candidate.passedTests ?? 0);
  const failed = Number(candidate.failedTests ?? 0);
  return passed + failed === 0 ? 0 : passed / (passed + failed);
}
