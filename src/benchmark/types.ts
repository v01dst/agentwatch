export interface BenchmarkMetric {
  name: string;
  value: number;
  unit: string;
}

export interface BenchmarkRunResult {
  agentId: string;
  model?: string;
  passedTests?: number;
  failedTests?: number;
  buildSucceeded?: boolean;
  lintSucceeded?: boolean;
  typecheckSucceeded?: boolean;
  assertionsPassed?: number;
  assertionsTotal?: number;
  durationMs?: number;
  commandCount?: number;
  errorCount?: number;
  filesChanged?: number;
  insertions?: number;
  deletions?: number;
  inputTokens?: number;
  outputTokens?: number;
  securityFindings?: number;
  metrics?: BenchmarkMetric[];
}

export interface ScoringWeights {
  testPassRate: number;
  build: number;
  lint: number;
  typecheck: number;
  assertions: number;
  duration: number;
  commands: number;
  errors: number;
  changes: number;
  tokens: number;
  security: number;
}

export interface ScoredCandidate {
  candidate: BenchmarkRunResult;
  score: number;
  breakdown: Array<{ metric: string; raw: number; normalized: number; weight: number; points: number }>;
}
