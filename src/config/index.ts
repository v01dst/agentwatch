import path from "node:path";

export interface ResolvedConfig {
  projectRoot: string;
  dataDir: string;
  databasePath: string;
  sessionsDir: string;
  exportsDir: string;
  schemaVersion: 1;
}

export function resolveConfig(projectRoot = process.cwd(), dataDirectory?: string): ResolvedConfig {
  const configured = dataDirectory ?? path.join(projectRoot, ".agentwatch");
  const absolute = path.isAbsolute(configured)
    ? configured
    : path.resolve(process.env.AGENTWATCH_DATA_DIR ?? projectRoot, configured);
  return {
    projectRoot,
    dataDir: absolute,
    databasePath: path.join(absolute, "index"),
    sessionsDir: path.join(absolute, "sessions"),
    exportsDir: path.join(absolute, "exports"),
    schemaVersion: 1,
  };
}
