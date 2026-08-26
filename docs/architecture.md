# Architecture

## Principles
1. Observe only: no permission manager, supervisor, approval flow, intervention, AI judge, or blocking path.
2. Local-first: all persistence, analysis, reporting, import/export, and history remain on disk.
3. Provider-neutral: one normalized event stream feeds every feature.
4. Deterministic benchmarks: compare measurements, never another model's opinion.
5. Secret-safe: redaction happens before terminal, JSON, report, export, and crash surfaces.

## Data flow
`CLI → AgentAdapter → transparent child process → event collector → NDJSON session`
The same event stream is consumed concurrently by security analyzers, metrics extractors,
report generators, and the benchmark engine. The benchmark engine reads only structured
candidate metrics and configurable weights.

## Modules
- `src/adapters/base.ts`: adapter contract, known adapters, generic launcher, token extraction hook.
- `src/observability/runner.ts`: child-process lifecycle, stdin forwarding, stdout/stderr capture,
  filesystem/git/package snapshots, resource sampling, signal handling, session persistence.
- `src/analysis/security.ts`: secret rules, fingerprints/redaction, command/path heuristics.
- `src/benchmark/engine.ts`: normalization, weighted deterministic scoring, comparison explanations.
- `src/storage/store.ts`: schema migration marker, atomic JSON catalogs, NDJSON session storage.
- `src/report/render.ts`: human-readable winner explanation and non-universal-ranking disclaimer.
- `src/cli.ts`: command parsing, JSON/human modes, import/export, help and errors.

## Event model
Events contain a UUID, ISO timestamp, monotonic sequence, kind, severity, and provider-independent data.
Core kinds cover session/process lifecycle, output streams, file/git/package/network/resource observations,
security findings, benchmark results, and adapter extensions. The versioned schema starts at `1`.

## Storage
NDJSON provides append-friendly raw sessions. Small atomic JSON catalogs provide indexes and avoid a native
SQLite dependency while retaining a clear migration boundary (`index/schema.json`). Future engines can replace
the store implementation without changing the public CLI or event contract.

## Platform design
Spawn uses explicit shell-free execution by default, platform-aware executable resolution, forwarded signals,
and Node streams. Windows differences are isolated in adapters/platform helpers rather than scattered POSIX assumptions.
Process-tree and network visibility are best-effort extension points because kernel APIs differ.

## Threat model
AgentWatch can only observe streams/files available to its process. It is not a sandbox, antivirus,
permission broker, or guarantee against exfiltration. It makes activity more visible while leaving control
with the user.
