import type { ScoredCandidate } from "../benchmark/types.js";
import { comparisonLines } from "../benchmark/engine.js";

export function comparisonReport(
  left: ScoredCandidate,
  right: ScoredCandidate,
  task: string,
  agents: [string, string],
): string {
  const winner = left.score === right.score ? null : left.score > right.score ? left : right;
  const loser = winner === left ? right : winner === right ? left : null;
  const headline = winner && loser
    ? `${agents[winner === left ? 0 : 1]} beat ${agents[loser === left ? 0 : 1]} on ${task}`
    : `${agents[0]} tied ${agents[1]} on ${task}`;
  const lines = comparisonLines(left, right).map((line) =>
    `- ${line.label}: ${line.left} vs ${line.right} — ${line.explanation}`);
  return [
    headline,
    "",
    "Why:",
    ...lines,
    "",
    `Weighted score: ${left.score} vs ${right.score}`,
    "",
    "Results are specific to this local benchmark task and are not universal model rankings.",
  ].join("\n");
}
