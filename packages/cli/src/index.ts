#!/usr/bin/env node --experimental-strip-types
import { pendingDecisions, projectRun } from "@kraken/core";
import { radar, git } from "@kraken/train";
import { openJournal, worktreeRoot } from "./home.ts";
import { loadConfig } from "./config.ts";
import { advanceCampaign, executeRun, planCampaign, planRunSafe } from "./run.ts";
import { serveMcp } from "./mcp.ts";
import { serveHelm } from "./serve.ts";

const [, , command, ...args] = process.argv;
const repo = flagValue("--repo") ?? process.cwd();

function flagValue(flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

switch (command) {
  case "run": {
    const goal = args.filter((a) => !a.startsWith("--") && a !== flagValue("--repo")).join(" ");
    if (!goal) die("usage: kraken run \"<goal>\" [--repo <path>]");
    const journal = openJournal();
    const runId = await planRunSafe(journal, loadConfig(repo), goal);
    const run = projectRun(journal, runId)!;
    console.log(`Run ${runId} planned — ${run.contracts.size} contracts:`);
    for (const c of run.contracts.values()) {
      console.log(`  ${c.contract.id} [${c.contract.modelTier}] ${c.contract.objective}`);
    }
    console.log(`\nApprove:  kraken decide ${runId} plan-${runId} approve`);
    console.log(`Execute:  kraken exec ${runId}`);
    break;
  }
  case "decide": {
    const [runId, decisionId, choice, ...rest] = args.filter((a) => !a.startsWith("--"));
    if (!runId || !decisionId || !choice) die("usage: kraken decide <runId> <decisionId> <choice> [annotation]");
    const journal = openJournal();
    journal.append({ type: "DecisionMade", runId, decisionId, choice, annotation: rest.join(" "), decidedBy: "cli" });
    if (decisionId.startsWith("plan-")) {
      journal.append({ type: "PlanDecision", runId, decision: choice === "approve" ? "approved" : "rejected", annotations: rest.length ? [rest.join(" ")] : [] });
    }
    console.log(`✓ ${decisionId} → ${choice}`);
    break;
  }
  case "exec": {
    const [runId] = args.filter((a) => !a.startsWith("--"));
    if (!runId) die("usage: kraken exec <runId> [--repo <path>]");
    await executeRun(openJournal(), loadConfig(repo), runId, worktreeRoot(), console.log);
    break;
  }
  case "campaign": {
    const reposFlag = flagValue("--repos");
    const intent = args.filter((a) => !a.startsWith("--") && a !== reposFlag && a !== flagValue("--repo")).join(" ");
    if (!intent || !reposFlag) die("usage: kraken campaign \"<intent>\" --repos /a,/b,/c");
    const repos = reposFlag.split(",").map((r) => r.trim()).filter(Boolean);
    const key = await planCampaign(openJournal(), intent, repos, process.cwd());
    const id = key.slice("campaign:".length);
    console.log(`Campaign ${id} planned across ${repos.length} repos.`);
    console.log(`Review plans as they appear (bridge or 'kraken decisions'); approval on the bridge auto-advances.`);
    console.log(`Advance manually with: kraken campaign-adv ${id}`);
    // First advance plans the root slice(s) so a plan shows up for review immediately.
    console.log(await advanceCampaign(openJournal(), key, worktreeRoot(), console.log));
    break;
  }
  case "campaign-adv": {
    const [id] = args.filter((a) => !a.startsWith("--"));
    if (!id) die("usage: kraken campaign-adv <campaignId>");
    const key = id.startsWith("campaign:") ? id : `campaign:${id}`;
    console.log(await advanceCampaign(openJournal(), key, worktreeRoot(), console.log));
    break;
  }
  case "decisions": {
    const pending = pendingDecisions(openJournal());
    if (pending.length === 0) console.log("No pending decisions.");
    for (const d of pending) console.log(`[${d.decisionId}] ${d.question}\n  → ${d.options.join(" | ")}`);
    break;
  }
  case "status": {
    const [runId] = args.filter((a) => !a.startsWith("--"));
    if (!runId) die("usage: kraken status <runId>");
    const run = projectRun(openJournal(), runId);
    if (!run) die(`run ${runId} not found`);
    console.log(`${run.runId} — "${run.goal}" (approved: ${run.planApproved}${run.outcome ? `, ${run.outcome}` : ""})`);
    for (const c of run.contracts.values()) {
      console.log(`  ${c.contract.id}: ${c.status}${c.ejectReason ? ` — ${c.ejectReason.slice(0, 120)}` : ""}`);
    }
    break;
  }
  case "radar": {
    const branches = (await git(repo, ["branch", "--list", "kraken/*", "--format=%(refname:short)"])).stdout
      .split("\n").filter(Boolean);
    const warnings = await radar(repo, branches);
    if (warnings.length === 0) console.log(`${branches.length} kraken branches, no brewing conflicts.`);
    for (const w of warnings) console.log(`⚠ ${w.branchA} × ${w.branchB}: ${w.files.join(", ")}`);
    break;
  }
  case "onboard": {
    openJournal().append({ type: "ProjectOnboarded", runId: `project:${repo}`, repoPath: repo });
    console.log(`registered ${repo} — it now appears on the bridge with its channel`);
    break;
  }
  case "mcp":
    await serveMcp(repo);
    break;
  case "serve": {
    const port = Number(flagValue("--port") ?? 4747);
    serveHelm(port);
    break;
  }
  default:
    console.log(`kraken — one head, many arms

  kraken run "<goal>"                    plan a run (frontier model → task contracts)
  kraken decide <run> <decision> <choice>  resolve a decision (plan approval, ejections)
  kraken exec <runId>                    dispatch arms + speculative merge train
  kraken campaign "<intent>" --repos /a,/b   one intent, N single-repo runs chained by dependency
  kraken campaign-adv <campaignId>       advance the campaign DAG (plan/exec what is ready)
  kraken decisions                       pending decision queue
  kraken status <runId>                  run state
  kraken radar                           pre-write conflict radar across kraken/* branches
  kraken onboard                         Register this repo on the bridge (no run needed)
  kraken mcp                             MCP server — drive Kraken from Claude Code
  kraken serve [--port 4747]             the bridge — mobile web UI over the journal

  --repo <path>   target repository (default: cwd). Config: <repo>/kraken.toml`);
}

function die(msg: string): never {
  console.error(msg);
  process.exit(1);
}
