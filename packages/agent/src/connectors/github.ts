/** GitHub connector via the owner's authenticated `gh` CLI. */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { RawItem } from "@standin/core";

const run = promisify(execFile);

/** PRs waiting on the owner: review requested of them, open. */
export async function ingestGithub(): Promise<RawItem[]> {
  const { stdout } = await run("gh", [
    "search", "prs",
    "--review-requested=@me", "--state=open",
    "--json", "number,title,url,repository,author,updatedAt",
    "--limit", "30",
  ]);
  const prs = JSON.parse(stdout) as {
    number: number;
    title: string;
    url: string;
    repository: { nameWithOwner: string };
    author: { login: string };
    updatedAt: string;
  }[];
  return prs.map((p) => ({
    source: "github" as const,
    externalId: p.url,
    title: `${p.repository.nameWithOwner}#${p.number}: ${p.title}`,
    url: p.url,
    actor: p.author.login,
    kind: "review-requested",
    body: null,
    createdAt: p.updatedAt,
  }));
}

export async function commentOnPr(prUrl: string, body: string): Promise<string> {
  await run("gh", ["pr", "comment", prUrl, "--body", body]);
  return `commented on ${prUrl}`;
}

export async function mergePr(prUrl: string): Promise<string> {
  await run("gh", ["pr", "merge", prUrl, "--squash"]);
  return `merged ${prUrl}`;
}
