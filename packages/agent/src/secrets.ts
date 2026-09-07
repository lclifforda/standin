/**
 * Connector secrets, stored in the brain dir with owner-only permissions —
 * written by the Connections UI after live validation, never hand-edited.
 * Env vars still win (useful for containers); this is the no-.env path.
 */
import { existsSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";

export type SecretName = "linearApiKey" | "slackBotToken";

type Secrets = Partial<Record<SecretName, string>>;

function secretsPath(brainDir: string): string {
  return join(brainDir, "secrets.json");
}

export function readSecrets(brainDir: string): Secrets {
  const path = secretsPath(brainDir);
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Secrets;
  } catch {
    return {};
  }
}

export function writeSecret(brainDir: string, name: SecretName, value: string | null): void {
  const path = secretsPath(brainDir);
  const secrets = readSecrets(brainDir);
  if (value === null) delete secrets[name];
  else secrets[name] = value;
  writeFileSync(path, JSON.stringify(secrets, null, 2) + "\n", { mode: 0o600 });
  chmodSync(path, 0o600); // writeFileSync mode is ignored if the file existed
}
