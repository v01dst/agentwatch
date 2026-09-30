# Security Model

AgentWatch is an observation layer, not a sandbox or permission manager.

## Trust boundary

The observed agent remains the process making decisions. AgentWatch records information visible to the parent process and filesystem, then writes local artifacts under the configured data directory.

AgentWatch does not approve or deny agent actions, inject approval prompts, modify agent commands, claim to prevent exfiltration, or provide antivirus-grade detection.

## Secret handling

Potential credentials should be redacted before they enter human-readable reports. A short fingerprint may be retained for correlation without retaining the secret itself.

New detectors should prefer conservative matching and should document false-positive tradeoffs.

## Local data

By default, session events, reports, benchmark artifacts, and exports remain on disk. Users control whether those artifacts are copied elsewhere.

## Threat-aware development

Security-related changes should include fixtures for both positive and negative cases. Tests should verify that redaction removes the sensitive value while preserving enough surrounding evidence to understand the event.
