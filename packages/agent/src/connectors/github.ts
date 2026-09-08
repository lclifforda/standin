/** GitHub connector via the owner's authenticated `gh` CLI. */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { RawItem } from "@standin/core";

const run = promisify(execFile);

interface SearchPr {
  number: number;
  title: string;
  url: string;
  repository: { nameWithOwner: string };
  author: { login: string };
  updatedAt: string;
}

async function searchPrs(filter: string, kind: string): Promise<RawItem[]> {
  const { stdout } = await run("gh", [
    "search", "prs",
    filter, "--state=open",
    "--json", "number,title,url,repository,author,updatedAt",
    "--limit", "20",
  ]);
  return (JSON.parse(stdout) as SearchPr[]).map((p) => ({
    source: "github" as const,
    externalId: p.url,
    title: `${p.repository.nameWithOwner}#${p.number}: ${p.title}`,
    url: p.url,
    actor: p.author.login,
    kind,
    body: null,
    createdAt: p.updatedAt,
  }));
}

/** PRs waiting on the owner's review + the owner's own open PRs. */
export async function ingestGithub(): Promise<RawItem[]> {
  const [requested, mine] = await Promise.all([
    searchPrs("--review-requested=@me", "review-requested"),
    searchPrs("--author=@me", "your-open-pr"),
  ]);
  const seen = new Set<string>();
  return [...requested, ...mine].filter((p) =>
    seen.has(p.externalId) ? false : (seen.add(p.externalId), true),
  );
}

export async function commentOnPr(prUrl: string, body: string): Promise<string> {
  await run("gh", ["pr", "comment", prUrl, "--body", body]);
  return `commented on ${prUrl}`;
}

export async function mergePr(prUrl: string): Promise<string> {
  await run("gh", ["pr", "merge", prUrl, "--squash"]);
  return `merged ${prUrl}`;
}
