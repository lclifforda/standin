/**
 * Runtime config: where the brain lives and which credentials the HANDS layer
 * has. Secrets come from the environment (or brain-dir .env), never from git.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { readSecrets } from "./secrets.ts";

export interface Config {
  brainDir: string;
  dbPath: string;
  model: string | undefined;
  linearApiKey: string | undefined;
  linearMcp: boolean; // connected keylessly via Linear's official MCP (OAuth)
  slackBotToken: string | undefined;
}

function loadDotEnv(path: string): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && m[1] && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2]!.replace(/^["']|["']$/g, "");
    }
  }
}

export function loadConfig(brainDirArg?: string): Config {
  const brainDir = resolve(
    brainDirArg ?? process.env.STANDIN_BRAIN ?? join(homedir(), "standin-data"),
  );
  if (!existsSync(brainDir))
    throw new Error(`brain dir not found: ${brainDir} — run scripts/standin-init first`);
  loadDotEnv(join(brainDir, ".env"));

  let fileCfg: Record<string, string> = {};
  const cfgPath = join(brainDir, "standin.config.json");
  if (existsSync(cfgPath)) fileCfg = JSON.parse(readFileSync(cfgPath, "utf8"));

  // Secrets saved by the Connections UI; env vars still override (containers).
  const secrets = readSecrets(brainDir);

  return {
    brainDir,
    dbPath: join(brainDir, "standin.db"),
    model: process.env.STANDIN_MODEL ?? fileCfg.model,
    linearApiKey: process.env.LINEAR_API_KEY ?? secrets.linearApiKey,
    linearMcp: secrets.linearMcp === "true",
    slackBotToken: process.env.SLACK_BOT_TOKEN ?? secrets.slackBotToken,
  };
}
