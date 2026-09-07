/** GitHub connector via the owner's authenticated `gh` CLI. Executors only. */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export async function commentOnPr(prUrl: string, body: string): Promise<string> {
  await run("gh", ["pr", "comment", prUrl, "--body", body]);
  return `commented on ${prUrl}`;
}

export async function mergePr(prUrl: string): Promise<string> {
  await run("gh", ["pr", "merge", prUrl, "--squash"]);
  return `merged ${prUrl}`;
}
