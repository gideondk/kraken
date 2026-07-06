import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { pendingDecisions, projectRun } from "@kraken/core";
import { radar } from "@kraken/train";
import { openJournal, worktreeRoot } from "./home.ts";
import { loadConfig } from "./config.ts";
import { executeRun, planRun } from "./run.ts";

/**
 * The MCP surface: any MCP client — a Claude Code session, Claude Desktop,
 * Codex — becomes a bridge. Register with:
 *   claude mcp add kraken -- kraken mcp --repo /path/to/repo
 */
export async function serveMcp(repoPath: string): Promise<void> {
  const journal = openJournal();
  const config = loadConfig(repoPath);
  const server = new McpServer({ name: "kraken", version: "0.1.0" });

  server.tool(
    "start_run",
    "Plan a new Kraken run: decompose a goal into task contracts. Returns the runId; the plan waits for approval via decide().",
    { goal: z.string().describe("The outcome to achieve, stated fully — intent, constraints, what done looks like") },
    async ({ goal }) => {
      const runId = await planRun(journal, config, goal);
      const run = projectRun(journal, runId)!;
      const plan = [...run.contracts.values()]
        .map((c) => `- ${c.contract.id} [${c.contract.modelTier}]: ${c.contract.objective} (owns: ${c.contract.boundaries.ownsPaths.join(", ")})`)
        .join("\n");
      return text(`Run ${runId} planned:\n${plan}\n\nApprove with decide(decisionId: "plan-${runId}", choice: "approve"), then execute_run.`);
    },
  );

  server.tool(
    "list_decisions",
    "List pending decisions across all runs — the queue a human (or a supervising session) drains.",
    {},
    async () => {
      const pending = pendingDecisions(journal);
      if (pending.length === 0) return text("No pending decisions. Fleet is autonomous right now.");
      return text(
        pending
          .map((d) => `[${d.decisionId}] ${d.question}\n  options: ${d.options.join(" | ")}\n  context: ${d.context.slice(0, 500)}`)
          .join("\n\n"),
      );
    },
  );

  server.tool(
    "decide",
    "Resolve a pending decision (plan approval, ejection handling, failure triage).",
    {
      runId: z.string(),
      decisionId: z.string(),
      choice: z.string(),
      annotation: z.string().optional().describe("Why — becomes part of the audit trail"),
    },
    async ({ runId, decisionId, choice, annotation }) => {
      journal.append({ type: "DecisionMade", runId, decisionId, choice, annotation: annotation ?? "", decidedBy: "mcp-client" });
      if (decisionId.startsWith("plan-")) {
        journal.append({ type: "PlanDecision", runId, decision: choice === "approve" ? "approved" : "rejected", annotations: annotation ? [annotation] : [] });
      }
      return text(`Decision ${decisionId} → ${choice}.`);
    },
  );

  server.tool(
    "execute_run",
    "Execute an approved run: dispatch arms in parallel worktrees, then merge via the speculative train. Long-running.",
    { runId: z.string() },
    async ({ runId }) => {
      const progress: string[] = [];
      await executeRun(journal, config, runId, worktreeRoot(), (m) => progress.push(m));
      const run = projectRun(journal, runId)!;
      const summary = [...run.contracts.values()]
        .map((c) => `- ${c.contract.id}: ${c.status}${c.ejectReason ? ` (${c.ejectReason.slice(0, 200)})` : ""}`)
        .join("\n");
      return text(`Run ${runId} finished (${run.outcome}).\n${summary}\n\nLog:\n${progress.join("\n")}`);
    },
  );

  server.tool(
    "run_status",
    "Current state of a run: contracts, statuses, judge scores, pending decisions.",
    { runId: z.string() },
    async ({ runId }) => {
      const run = projectRun(journal, runId);
      if (!run) return text(`Run ${runId} not found.`);
      const lines = [...run.contracts.values()].map((c) => {
        const judge = c.lastJudgeScore !== undefined ? ` · judge ${c.lastJudgeScore.toFixed(2)}` : "";
        const cost = c.costUsd ? ` · $${c.costUsd.toFixed(2)}` : "";
        const rep = c.report ? `\n    ${c.report.summary.slice(0, 200)}${c.report.blockers.length ? `\n    blockers: ${c.report.blockers.join("; ").slice(0, 200)}` : ""}` : "";
        return `- ${c.contract.id}: ${c.status}${c.branch ? ` @ ${c.branch}` : ""}${judge}${cost}${rep}`;
      });
      return text(`Run ${runId} — "${run.goal}"\nplan approved: ${run.planApproved}\n${lines.join("\n")}`);
    },
  );

  server.tool(
    "register_project",
    "Register this repository on the Kraken bridge (sidebar group + channel) without needing a first run. Call after onboarding a repo.",
    {},
    async () => {
      journal.append({ type: "ProjectOnboarded", runId: `project:${config.repo}`, repoPath: config.repo });
      return text(`Registered ${config.repo} on the bridge.`);
    },
  );

  server.tool(
    "conflict_radar",
    "Pre-write conflict radar: merge-tree simulation across live kraken/* branches. Surfaces collisions before they become merge failures.",
    {},
    async () => {
      const { git } = await import("@kraken/train");
      const branches = (await git(config.repo, ["branch", "--list", "kraken/*", "--format=%(refname:short)"])).stdout
        .split("\n").filter(Boolean);
      if (branches.length < 2) return text(`Only ${branches.length} live kraken branch(es) — nothing to collide.`);
      const warnings = await radar(config.repo, branches);
      if (warnings.length === 0) return text(`${branches.length} branches, no brewing conflicts.`);
      return text(warnings.map((w) => `⚠ ${w.branchA} × ${w.branchB}: ${w.files.join(", ")}`).join("\n"));
    },
  );

  await server.connect(new StdioServerTransport());
}

function text(t: string): { content: { type: "text"; text: string }[] } {
  return { content: [{ type: "text", text: t }] };
}
