import type { SpawnOptions } from "node:child_process";

export interface AdapterLaunch {
  command: string;
  args: string[];
  spawnOptions?: SpawnOptions;
}

export interface AgentAdapter {
  readonly name: string;
  launch(argv: string[], options: { cwd: string; model?: string }): AdapterLaunch;
  extractTokenUsage?(stdout: string, stderr: string): { input?: number; output?: number };
}

function executableOnPlatform(name: string): string {
  return process.platform === "win32" && !name.includes(".") ? `${name}.cmd` : name;
}

export class GenericAdapter implements AgentAdapter {
  constructor(readonly name = "generic") {}

  launch(argv: string[]): AdapterLaunch {
    const [command, ...args] = argv;
    if (!command) throw new Error("No agent command was provided");
    return {
      command: executableOnPlatform(command),
      args,
      spawnOptions: { shell: false },
    };
  }
}

const knownAdapters = new Map<string, AgentAdapter>([
  ["codex", new GenericAdapter("codex")],
  ["claude", new GenericAdapter("claude")],
  ["opencode", new GenericAdapter("opencode")],
]);

export function resolveAdapter(argv: string[]): { adapter: AgentAdapter; argv: string[] } {
  const explicitIndex = argv.indexOf("--adapter");
  let name = "generic";
  let nextArgv = [...argv];
  if (explicitIndex >= 0) {
    const value = argv[explicitIndex + 1];
    if (!value) throw new Error("--adapter requires a value");
    name = value;
    nextArgv.splice(explicitIndex, 2);
  }
  const adapterName = nextArgv[0] ?? "";
  const adapter = knownAdapters.get(adapterName) ?? new GenericAdapter(name);
  return { adapter, argv: nextArgv };
}

export function tokenUsage(stdout: string, stderr: string): { input?: number; output?: number } {
  const combined = `${stdout}\n${stderr}`;
  const patterns = [
    /(?:input[_ -]?tokens?)["':=\s]+(\d+)/i,
    /"prompt_tokens"\s*:\s*(\d+)/i,
  ];
  const outputPatterns = [/(?:output[_ -]?tokens?)["':=\s]+(\d+)/i, /"completion_tokens"\s*:\s*(\d+)/i];
  const input = Number(patterns.map((pattern) => combined.match(pattern)?.[1]).find(Boolean));
  const output = Number(outputPatterns.map((pattern) => combined.match(pattern)?.[1]).find(Boolean));
  return {
    ...(Number.isFinite(input) ? { input } : {}),
    ...(Number.isFinite(output) ? { output } : {}),
  };
}
