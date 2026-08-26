# AgentWatch

AgentWatch is a **local-first observability and benchmarking layer** for autonomous coding agents.
It launches the command you choose, preserves normal terminal interaction, records what happened,
and reports measurable results. It does not manage permissions, approve or deny actions, pause work,
or modify agent behavior.

## Install
```bash
npm install -g @agentwatch/cli
agentwatch --help
```
For development:
```bash
cd agentwatch
npm install
npm run build
./bin/agentwatch.js --help
```

## Observe an agent
```bash
agentwatch run -- codex "fix the failing tests"
agentwatch run --adapter codex -- claude "refactor auth.ts"
agentwatch run --json -- node ./your-agent.js
```
Use `Ctrl+C` normally. AgentWatch forwards signals to the observed process and records lifecycle data.

## Inspect sessions
```bash
agentwatch session <id>
agentwatch inspect <id> --json
agentwatch report <id>
agentwatch history
```

## Deterministic benchmarks
Create a task directory containing source, setup commands, evaluation commands, and a `task.json`:
```json
{
  "id": "calculate-cli",
  "description": "Implement a small CLI",
  "evaluation": ["npm test"],
  "expectedOutput": "all tests passed"
}
```
Run candidates locally:
```bash
agentwatch benchmark ./examples/benchmark-tasks/calculate-cli --agent codex:gpt-5 --agent opencode:model-x
```
Reports explain exactly which deterministic measurements won: tests, build status, duration, commands, errors, changes, and token counts when an adapter exposes them.

Compare saved runs with `agentwatch compare result-a.json result-b.json`.

## Security findings
AgentWatch scans captured output and local project state for provider keys, tokens, private keys,
credential assignments, high-entropy strings, sensitive paths, risky commands, and dependency lifecycle
changes. Evidence is redacted; reports include a short SHA-256 fingerprint instead of a secret value.
Findings are informational only.

## Storage and privacy
Data stays in `./.agentwatch/` by default. Set `AGENTWATCH_DATA_DIR=/any/local/path` to relocate it.
There is no account, hosted backend, telemetry endpoint, API key, or external AI judge.

| Path | Purpose |
|---|---|
| `.agentwatch/index/sessions.json` | Session catalog |
| `.agentwatch/index/benchmarks.json` | Benchmark catalog |
| `.agentwatch/sessions/*.ndjson` | Append-only normalized events |
| `.agentwatch/exports/` | Local import/export files |

## Configuration reference
| Environment / option | Meaning | Default |
|---|---|---|
| `AGENTWATCH_DATA_DIR` | Absolute or relative local storage directory | `<project>/.agentwatch` |
| `--adapter <name>` | Adapter selection; built-ins include `codex`, `claude`, `opencode`, plus generic fallback | inferred |
| `--model <model>` | Exposed as `AGENTWATCH_MODEL`; adapter-specific model flags belong in your wrapper script | none |
| `--json` | Machine-readable output where supported | off |

## Adapter API
An adapter receives user arguments and returns a platform-aware executable plus spawn options:

```ts
export interface AgentAdapter {
  name: string;
  launch(argv: string[], options: { cwd: string; model?: string }): AdapterLaunch;
  extractTokenUsage?(stdout: string, stderr: string): { input?: number; output?: number };
}
```
Adapters may normalize provider output and token usage but cannot intercept approvals or alter agent decisions.

## Extending evaluation
Deterministic evaluators consume observable metrics such as exit codes, parsed pass/fail counts,
build/lint/type-check status, assertion ratios, diff statistics, duration, process/output errors,
filesystem changes, resource samples, security findings, and optional token usage. Task-specific logic
can emit additional metrics through adapters or wrapper scripts while keeping scoring reproducible.

Results describe performance on your machine and tasks only—not universal model rankings.

## Limitations
Filesystem observation intentionally uses conservative project-root snapshots. Process-tree accounting
and network attribution vary across operating systems; AgentWatch records available metadata without
injecting itself into agent processes. Always review generated code before executing or publishing it.

## License
Apache-2.0
