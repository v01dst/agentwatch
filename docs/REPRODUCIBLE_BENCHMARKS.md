# Reproducible benchmark runs

AgentWatch benchmark results are only meaningful when the inputs that affect a run are recorded alongside the result.

## Minimum run metadata

Record:
- task identifier and task revision;
- agent/provider/model identifier;
- prompt or task instructions;
- repository revision;
- operating system and Node.js version;
- relevant environment flags;
- evaluation commands and expected outputs.

## Comparing runs

Prefer comparing runs that share the same task revision and evaluation rules. A change in the machine, model configuration, dependency tree, or evaluator can otherwise look like a model improvement.

For local regression testing, keep the task directory immutable during evaluation and store the generated result artifact separately.

## Reporting

A useful report should make it possible to answer:
1. What was run?
2. Against which exact task?
3. What changed?
4. Which deterministic checks passed?
5. What environment differences could explain the result?

AgentWatch intentionally reports measurements rather than universal model rankings. Treat benchmark results as evidence about a particular task and environment.
