# Deterministic Benchmarking

AgentWatch benchmarks should measure observable outcomes rather than asking another model to judge the result.

## Evaluation layers

1. Execution — exit status, duration, command count, and errors.
2. Correctness — tests, assertions, expected output, and build/type-check status.
3. Change surface — files changed, additions, deletions, and unexpected modifications.
4. Security signals — credential-like material, risky commands, sensitive paths, and dependency changes.
5. Resource signals — CPU/RSS samples and token usage when a provider exposes them.

## Reproducibility

A benchmark result is meaningful only in the context of its task, prompt, repository state, machine, environment, and AgentWatch version. Store those inputs alongside the result so a future run can explain differences.

Avoid hidden network dependencies in evaluation commands. Prefer fixtures and deterministic scripts. If a task genuinely requires network access, record that requirement explicitly.

## Scoring

Weights belong to the task configuration. A score is a compact summary of measured dimensions, not a universal model ranking. Reports should preserve the raw measurements so users can inspect how a score was produced.

## Adding a benchmark

Keep each task self-contained. The task configuration describes setup and evaluation, fixtures remain small and deterministic, expected outputs are exact where possible, and failure modes are intentional and testable.
