import path from "node:path";

export interface ResolvedConfig {
  projectRoot: string;
  dataDir: string;
  databasePath: string;
  sessionsDir: string;
  exportsDir: string;
  schemaVersion: 2;
}

export function resolveConfig(projectRoot = process.cwd(), dataDirectory?: string): ResolvedConfig {
  const configured = process.env.AGENTWATCH_DATA_DIR ?? dataDirectory ?? path.join(projectRoot, ".agentwatch");
  const absolute = path.isAbsolute(configured)
    ? configured
    : path.resolve(projectRoot, configured);
  return {
    projectRoot,
    dataDir: absolute,
    databasePath: path.join(absolute, "index"),
    sessionsDir: path.join(absolute, "sessions"),
    exportsDir: path.join(absolute, "exports"),
    schemaVersion: 2,
  };
}
