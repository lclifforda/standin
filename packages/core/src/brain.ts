/**
 * The brain is a folder of plain markdown the owner can read, edit, and
 * git-diff. This module is the only reader/writer, so its shape stays in one
 * place: roles/<name>.md (profile), memory/DECISIONS.md (learning log),
 * triage/TRIAGE.md + triage/SAFETY_CONTRACT.md (rules).
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface Brain {
  dir: string;
  profileName: string;
  profile: string;
  decisions: string;
  triageRules: string;
  safetyContract: string;
}

export function loadBrain(dir: string): Brain {
  const rolesDir = join(dir, "roles");
  const profiles = readdirSync(rolesDir).filter(
    (f) => f.endsWith(".md") && !f.startsWith("_") && f !== "EXAMPLES.md",
  );
  const profileFile = profiles[0];
  if (!profileFile)
    throw new Error(
      `no profile in ${rolesDir} — run onboarding first ("onboard me" in the CLI)`,
    );
  return {
    dir,
    profileName: profileFile.replace(/\.md$/, ""),
    profile: readFileSync(join(rolesDir, profileFile), "utf8"),
    decisions: readFileSync(join(dir, "memory", "DECISIONS.md"), "utf8"),
    triageRules: readFileSync(join(dir, "triage", "TRIAGE.md"), "utf8"),
    safetyContract: readFileSync(join(dir, "triage", "SAFETY_CONTRACT.md"), "utf8"),
  };
}

/** Append a learned rule under "## Rules (learned)" so triage improves. */
export function appendDecision(dir: string, line: string): void {
  const path = join(dir, "memory", "DECISIONS.md");
  const current = readFileSync(path, "utf8");
  const marker = "## Rules (learned)";
  const idx = current.indexOf(marker);
  const date = new Date().toISOString().slice(0, 10);
  const entry = `- [${date}] ${line}`;
  const updated =
    idx === -1
      ? `${current.trimEnd()}\n\n${marker}\n\n${entry}\n`
      : current.slice(0, idx + marker.length) + `\n\n${entry}` + current.slice(idx + marker.length);
  writeFileSync(path, updated);
}
