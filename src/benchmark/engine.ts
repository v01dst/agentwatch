import type { BenchmarkRunResult, ScoredCandidate, ScoringWeights } from "./types.js";

export const defaultWeights: ScoringWeights = {
  testPassRate: 45, build: 15, lint: 5, typecheck: 10, assertions: 10,
  duration: 6, commands: 3, errors: 3, changes: 2, tokens: 1, security: 0,
};

export function scoreCandidates(candidates: BenchmarkRunResult[], weights: Partial<ScoringWeights> = {}): ScoredCandidate[] {
  const effective = { ...defaultWeights, ...weights };
  const totalWeight = Object.values(effective).reduce((sum, value) => sum + value, 0);
  if (totalWeight === 0) throw new Error("At least one scoring weight must be positive");
  const maxima = maximaFor(candidates);
  const scored = candidates.map((candidate) => score(candidate, effective));
  return scored.map((entry) => ({
    ...entry,
    score: Number(entry.breakdown.reduce((sum, item) => sum + item.points, 0).toFixed(4)),
  })).sort((a, b) => b.score - a.score);

  function score(candidate: BenchmarkRunResult, config: ScoringWeights): ScoredCandidate {
    const testsTotal = (candidate.passedTests ?? 0) + (candidate.failedTests ?? 0);
    const values: Array<[string, number, keyof ScoringWeights]> = [
      ["testPassRate", testsTotal ? candidate.passedTests! / testsTotal : 0, "testPassRate"],
      ["build", bool(candidate.buildSucceeded), "build"], ["lint", bool(candidate.lintSucceeded), "lint"],
      ["typecheck", bool(candidate.typecheckSucceeded), "typecheck"],
      ["assertions", ratio(candidate.assertionsPassed, candidate.assertionsTotal), "assertions"],
      ["duration", inverse(candidate.durationMs, maxima.durationMs!), "duration"],
      ["commands", inverse(candidate.commandCount, maxima.commandCount!), "commands"],
      ["errors", inverse(candidate.errorCount, Math.max(1, maxima.errorCount!)), "errors"],
      ["changes", inverse(changeCount(candidate), Math.max(1, maxima.changeCount!)), "changes"],
      ["tokens", inverse(tokenCount(candidate), Math.max(1, maxima.tokenCount!)), "tokens"],
      ["security", inverse(candidate.securityFindings ?? 0, 1), "security"],
    ];
    const breakdown = values.map(([metric, raw, weightName]) => {
      const weight = config[weightName];
      const normalized = Number(raw.toFixed(6));
      return { metric, raw: Number(raw.toFixed(6)), normalized, weight, points: Number((normalized * weight).toFixed(6)) };
    });
    return { candidate, score: 0, breakdown };
  }
}

export interface ReportLine { label: string; winner: "left" | "right" | "tie"; left: string; right: string; explanation: string }

export function comparisonLines(left: ScoredCandidate, right: ScoredCandidate): ReportLine[] {
  const lines: ReportLine[] = [];
  const testsLeft = testRate(left.candidate); const testsRight = testRate(right.candidate);
  push("tests passed", percent(testsLeft), percent(testsRight), `${Math.round(Math.abs(testsLeft - testsRight) * 100)} percentage points`);
  pushDuration(); pushCommands(); pushTokens();
  const securityLeft = left.candidate.securityFindings ?? 0; const securityRight = right.candidate.securityFindings ?? 0;
  lines.push({
    label: "security findings", winner: securityLeft < securityRight ? "left" : securityRight < securityLeft ? "right" : "tie",
    left: String(securityLeft), right: String(securityRight),
    explanation: `${Math.abs(securityLeft - securityRight)} fewer ${securityLeft > securityRight ? "for right" : "for left"}`,
  });
  return lines;

  function push(label: string, l: string, r: string, explanation: string): void {
    lines.push({ label, winner: "tie", left: l, right: r, explanation });
  }
  function pushDuration(): void {
    const l = left.candidate.durationMs; const r = right.candidate.durationMs;
    if (!l || !r || l === r) return push("duration", formatMs(l), formatMs(r), "equal");
    const faster = l < r ? "left" : "right"; const diff = Math.round((Math.max(l,r)-Math.min(l,r))/Math.max(l,r)*100);
    lines.push({ label: "execution time", winner: faster, left: formatMs(l), right: formatMs(r), explanation: `${diff}% faster` });
  }
  function pushCommands(): void {
    const l = left.candidate.commandCount; const r = right.candidate.commandCount;
    if (!l && !r || l === r) return;
    const lower = l! < r! ? "left" : "right"; const reduction = Math.round((1-Math.min(l!,r!)/Math.max(l!,r!))*100);
    lines.push({ label: "commands", winner: lower, left:String(l), right:String(r), explanation:`${reduction}% fewer` });
  }
  function pushTokens(): void {
    const l=tokenCount(left.candidate),r=tokenCount(right.candidate);
    if(!l||!r||l===r)return;
    const lower=l<r?"left":"right"; const reduction=Math.round((1-Math.min(l,r)/Math.max(l,r))*100);
    lines.push({label:"tokens",winner:lower,left:String(l),right:String(r),explanation:`${reduction}% fewer`});
  }
}

function maximaFor(candidates: BenchmarkRunResult[]): Record<string, number | undefined> {
  return {
    durationMs: positiveMax(candidates.map((candidate) => candidate.durationMs)),
    commandCount: positiveMax(candidates.map((candidate) => candidate.commandCount)),
    errorCount: positiveMax(candidates.map((candidate) => candidate.errorCount)),
    changeCount: positiveMax(candidates.map((candidate) => changeCount(candidate))),
    tokenCount: positiveMax(candidates.map((candidate) => tokenCount(candidate))),
  };
}

function positiveMax(values: Array<number | undefined>): number | undefined {
  const defined = values.filter((value): value is number => typeof value === "number" && value >= 0);
  return defined.length ? Math.max(...defined) : undefined;
}
function bool(value: boolean | undefined): number { return value ? 1 : 0; }
function ratio(passed?: number, total?: number): number { return total ? (passed ?? 0) / total : 0; }
function testRate(result: BenchmarkRunResult): number { return ratio(result.passedTests, (result.passedTests ?? 0)+(result.failedTests ?? 0)); }
function changeCount(result: BenchmarkRunResult): number { return result.filesChanged ?? 0; }
function tokenCount(result: BenchmarkRunResult): number { return (result.inputTokens ?? 0)+(result.outputTokens ?? 0); }
function percent(value: number): string { return `${Math.round(value * 100)}%`; }
function formatMs(value?: number): string { return value == null ? "unknown" : `${value} ms`; }
function inverse(value: number | undefined, maximum: number): number {
  if (value === undefined) return 0;
  return maximum <= 0 || value <= 0 ? 1 : 1 - value / maximum;
}
