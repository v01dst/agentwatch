export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export type JsonObject = { [key: string]: JsonValue };

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
  | "network.observation.detail"
  | "network.observation"
  | "resource.usage"
  | "security.finding"
  | "benchmark.result"
  | "adapter.custom"
  | "session.recovered";

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

export type SessionStatus = "running" | "incomplete" | "success" | "failed" | "signaled";

export interface SessionManifest {
  id: string;
  startedAt: string;
  endedAt?: string;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  durationMs?: number;
  command: string[];
  cwd: string;
  adapter: string;
  status: SessionStatus;
  pid?: number;
  eventCount?: number;
  complete?: boolean;
}

export interface NetworkConnection {
  protocol?: string;
  localAddress?: string;
  localPort?: number;
  remoteAddress?: string;
  remotePort?: number;
  state?: string;
  pid?: number;
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
