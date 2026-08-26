export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export type EventKind =
  | "session.start"
  | "session.end"
  | "process.start"
  | "process.exit"
  | "process.tree"
  | "output.stdout"
  | "output.stderr"
  | "stdin.forward"
  | "file.change"
  | "git.change"
  | "package.install"
  | "network.observation"
  | "resource.usage"
  | "security.finding"
  | "benchmark.result"
  | "adapter.custom";

export type EventSeverity = "info" | "warning" | "critical";

export interface AgentWatchEvent {
  id: string;
  timestamp: string;
  sequence: number;
  kind: EventKind;
  severity?: EventSeverity;
  data: Record<string, JsonValue>;
}

export interface ProcessSnapshot {
  pid: number;
  parentPid?: number;
  command?: string;
  cpuPercent?: number;
  memoryBytes?: number;
}

export interface SessionSummary {
  id: string;
  startedAt: string;
  endedAt?: string;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  durationMs?: number;
  command: string[];
  cwd: string;
  adapter: string;
  status: "running" | "success" | "failed" | "signaled";
}

export interface Finding {
  id: string;
  category:
    | "secret"
    | "suspicious-command"
    | "sensitive-file"
    | "dependency-change"
    | "unexpected-modification";
  severity: EventSeverity;
  title: string;
  detail: string;
  evidence?: string;
  fingerprint?: string;
  filePath?: string;
  line?: number;
}
