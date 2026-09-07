/**
 * Build the executor registry from configured credentials. Executors are
 * deterministic API calls — no model sits in the send path, so what the owner
 * approved is exactly what goes out. Only core's `executeApproved` calls them.
 */
import type { ExecutorRegistry } from "@standin/core";
import type { Config } from "./config.ts";
import { sendLinearComment } from "./connectors/linear.ts";
import { sendSlackMessage } from "./connectors/slack.ts";
import { commentOnPr, mergePr } from "./connectors/github.ts";

export function buildExecutors(config: Config): ExecutorRegistry {
  const registry: ExecutorRegistry = {
    // gh is auth'd machine-wide; merges/comments still require an approval id.
    "github.comment": (a) =>
      a.kind === "github.comment" ? commentOnPr(a.prUrl, a.body) : Promise.reject(),
    "github.merge": (a) => (a.kind === "github.merge" ? mergePr(a.prUrl) : Promise.reject()),
  };
  if (config.linearApiKey) {
    const key = config.linearApiKey;
    registry["linear.comment"] = (a) =>
      a.kind === "linear.comment"
        ? sendLinearComment(key, a.issueId, a.body)
        : Promise.reject(new Error("wrong action kind"));
  }
  if (config.slackBotToken) {
    const token = config.slackBotToken;
    registry["slack.message"] = (a) =>
      a.kind === "slack.message"
        ? sendSlackMessage(token, a.channel, a.text)
        : Promise.reject(new Error("wrong action kind"));
  }
  return registry;
}
