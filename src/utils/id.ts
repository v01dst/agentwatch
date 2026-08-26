import { randomUUID } from "node:crypto";

export function sessionId(): string {
  const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  return `${timestamp}-${randomUUID().slice(0, 8)}`;
}

export function eventId(): string {
  return randomUUID();
}
