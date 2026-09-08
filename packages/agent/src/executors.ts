/**
 * Build the executor registry from configured credentials. Executors are
 * deterministic API calls — no model sits in the send path, so what the owner
 * approved is exactly what goes out. Only core's `executeApproved` calls them.
 */
import type { ExecutorRegistry } from "@standin/core";
import type { Config } from "./config.ts";
import { sendLinearComment, setLinearStatus } from "./connectors/linear.ts";
import { sendLinearCommentOAuth, setLinearStatusOAuth } from "./connectors/linear-mcp.ts";
import { sendSlackMessage } from "./connectors/slack.ts";
import { closePr, commentOnPr, mergePr } from "./connectors/github.ts";

export function buildExecutors(config: Config): ExecutorRegistry {
  const registry: ExecutorRegistry = {
    // gh is auth'd machine-wide; merges/comments/closes still require an approval id.
    "github.comment": (a) =>
      a.kind === "github.comment" ? commentOnPr(a.prUrl, a.body) : Promise.reject(),
    "github.merge": (a) => (a.kind === "github.merge" ? mergePr(a.prUrl) : Promise.reject()),
    "github.close": (a) => (a.kind === "github.close" ? closePr(a.prUrl) : Promise.reject()),
  };
  if (config.linearApiKey) {
    const key = config.linearApiKey;
    registry["linear.comment"] = (a) =>
      a.kind === "linear.comment"
        ? sendLinearComment(key, a.issueId, a.body)
        : Promise.reject(new Error("wrong action kind"));
    registry["linear.status"] = (a) =>
      a.kind === "linear.status"
        ? setLinearStatus(key, a.issueId, a.status)
        : Promise.reject(new Error("wrong action kind"));
  } else if (config.linearMcp) {
    registry["linear.comment"] = (a) =>
      a.kind === "linear.comment"
        ? sendLinearCommentOAuth(a.issueId, a.body)
        : Promise.reject(new Error("wrong action kind"));
    registry["linear.status"] = (a) =>
      a.kind === "linear.status"
        ? setLinearStatusOAuth(a.issueId, a.status)
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
