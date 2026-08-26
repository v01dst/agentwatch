import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { Finding, JsonValue } from "../types.js";

interface SecretRule {
  name: string;
  pattern: RegExp;
  severity: "warning" | "critical";
}

const secretRules: SecretRule[] = [
  { name: "AWS access key", pattern: /\bAKIA[0-9A-Z]{16}\b/g, severity: "critical" },
  { name: "GitHub token", pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, severity: "critical" },
  { name: "OpenAI-style API key", pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/g, severity: "critical" },
  { name: "Anthropic-style API key", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g, severity: "critical" },
  { name: "Private key", pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g, severity: "critical" },
  {
    name: "Credential assignment",
    pattern: /^\s*(?:API_KEY|ACCESS_TOKEN|SECRET|PASSWORD|PASSWD|AUTH_TOKEN)\s*[:=]\s*["']?[^"'\s]{8,}/gim,
    severity: "critical",
  },
  { name: "High-entropy string", pattern: /[A-Za-z0-9+/=_-]{40,}/g, severity: "warning" },
];

const sensitiveFiles = new Set([".env", ".env.local", ".npmrc", ".netrc", "id_rsa", "credentials.json"]);

export function fingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function findingId(ruleName: string, match: string): string {
  return ruleName === "Credential assignment"
    ? fingerprint(`assignment:${match}`)
    : fingerprint(`value:${match}`);
}

function redact(match: string): string {
  const prefix = match.slice(0, Math.min(4, match.length));
  return `${prefix}…[redacted]`;
}

export async function scanText(text: string): Promise<Finding[]> {
  const findings: Finding[] = [];
  const reportedValues = new Set<string>();
  for (const rule of secretRules) {
    const matches = text.match(rule.pattern) ?? [];
    for (const match of matches) {
      if (rule.name === "High-entropy string") {
        if (!/[a-z]/.test(match) || !/[A-Z]/.test(match) || !/\d/.test(match)) continue;
        if (match.includes("_")) continue;
        if (/^[0-9a-f]{40,}$/i.test(match) && new Set(match).size < 16) continue;
      }
      if (rule.name === "OpenAI-style API key" && match.startsWith("sk-ant-")) continue;
      const secretValue = rule.name === "Credential assignment"
        ? (match.split(/[:=]\s*/).pop() ?? match)
        : match;
      const valueFingerprint = fingerprint(secretValue);
      if (reportedValues.has(valueFingerprint)) continue;
      reportedValues.add(valueFingerprint);
      findings.push({
        id: findingId(rule.name, match), category: "secret", severity: rule.severity, title: rule.name,
        detail: `Potential ${rule.name.toLowerCase()} detected`, evidence: redact(match), fingerprint: valueFingerprint,
      });
    }
  }
  return dedupe(findings);
}

export async function scanProject(projectRoot: string): Promise<Finding[]> {
  const findings = await scanText(await safeRead(path.join(projectRoot, ".env")));
  const packageJson = await safeRead(path.join(projectRoot, "package.json"));
  if (packageJson.includes("postinstall")) {
    findings.push({
      id: fingerprint("dependency-script"), category: "dependency-change", severity: "warning",
      title: "Package lifecycle script", detail: "package.json contains a postinstall script", filePath: "package.json",
    });
  }
  return findings;
}

export function analyzeEvents(events: Array<{ kind: string; data: Record<string, JsonValue> }>): Finding[] {
  const suspicious = [/\brm\s+-rf\b/, /\bcurl\b[^\n|]*\|\s*(?:ba)?sh/, /\bchmod\s+777\b/, /\bgit\s+push\b/, /\bnpm\s+(?:install|i)\b/];
  const sensitivePaths = [/\.env(?:\.|$)/, /\.ssh\//, /\.aws\//, /\.netrc$/, /credentials/i];
  const findings: Finding[] = [];
  for (const event of events) {
    const command = String(event.data.command ?? event.data.line ?? "");
    if (suspicious.some((pattern) => pattern.test(command))) {
      findings.push({
        id: fingerprint(`command:${command}`), category: "suspicious-command", severity: "warning",
        title: "Potentially risky command", detail: "Observed a command matching a local risk heuristic", evidence: redact(command),
      });
    }
    const file = String(event.data.file ?? "");
    if (file && sensitivePaths.some((pattern) => pattern.test(file))) {
      findings.push({
        id: fingerprint(`file:${file}`), category: "sensitive-file", severity: "critical",
        title: "Sensitive path accessed or modified", detail: "The observed change touched a sensitive local path", filePath: file,
      });
    }
  }
  return dedupe(findings);
}

async function safeRead(filePath: string): Promise<string> {
  try { return await fs.readFile(filePath, "utf8"); } catch { return ""; }
}

function dedupe(findings: Finding[]): Finding[] {
  return [...new Map(findings.map((finding) => [finding.id, finding])).values()];
}
