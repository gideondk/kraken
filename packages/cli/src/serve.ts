import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { existsSync, openSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pendingDecisions, projectCampaign, projectRun, type Journal } from "@kraken/core";
import { ClaudeArm } from "@kraken/arms";
import { git } from "@kraken/train";
import { krakenHome, openJournal } from "./home.ts";
import { loadConfig } from "./config.ts";

const BRIDGE_DIST = fileURLToPath(new URL("../../bridge/dist", import.meta.url));
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css",
  ".svg": "image/svg+xml", ".woff2": "font/woff2", ".png": "image/png",
};

/**
 * The bridge: a zero-dependency, mobile-first web UI over the journal.
 * Decisions are the front door; fleet state is one thumb-scroll below.
 * Cross-process by design — exec writes SQLite, serve polls it, phones
 * connect over Tailscale. SSE keeps the page live without a framework.
 */
export function serveHelm(port: number): void {
  const journal = openJournal();
  const server = createServer(async (req, res) => {
    try {
      await handle(req, res);
    } catch (err) {
      console.error("request failed:", err);
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: err instanceof Error ? err.message.slice(0, 300) : "internal error" }));
    }
  });

  async function handle(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://x");
    if (!url.pathname.startsWith("/api/")) {
      // Built TanStack app when present; embedded fallback otherwise.
      if (existsSync(BRIDGE_DIST)) {
        const asset = url.pathname === "/" || !existsSync(join(BRIDGE_DIST, url.pathname))
          ? join(BRIDGE_DIST, "index.html")
          : join(BRIDGE_DIST, url.pathname);
        res.writeHead(200, { "content-type": MIME[extname(asset)] ?? "application/octet-stream" });
        res.end(readFileSync(asset));
      } else {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        res.end(PAGE);
      }
    } else if (url.pathname === "/api/state") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(state(journal)));
    } else if (url.pathname === "/api/events") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      let cursor = lastSeq(journal);
      const timer = setInterval(() => {
        const fresh = journal.read({ afterSeq: cursor });
        if (fresh.length > 0) {
          cursor = fresh[fresh.length - 1]!.seq;
          res.write(`data: ${JSON.stringify({ changed: fresh.length })}\n\n`);
        } else {
          res.write(": keepalive\n\n");
        }
      }, 2000);
      req.on("close", () => clearInterval(timer));
    } else if (url.pathname === "/api/decide" && req.method === "POST") {
      const body = await readBody(req);
      const { runId, decisionId, choice, annotation, decidedBy } = JSON.parse(body) as {
        runId: string; decisionId: string; choice: string; annotation?: string; decidedBy?: string;
      };
      journal.append({ type: "DecisionMade", runId, decisionId, choice, annotation: annotation ?? "", decidedBy: decidedBy ?? "bridge" });
      if (decisionId.startsWith("plan-")) {
        journal.append({
          type: "PlanDecision", runId,
          decision: choice === "approve" ? "approved" : "rejected",
          annotations: annotation ? [annotation] : [],
        });
        // Campaign children: approving a plan must advance the DAG — the
        // detached reconcile executes this run, then plans its dependents.
        if (choice === "approve") {
          const campaignId = campaignOf(journal, runId);
          if (campaignId) detachedKraken(["campaign-adv", campaignId]);
        }
      }
      // Actionable mid-run choices execute themselves — deciding IS acting.
      // Reconcile stays as the manual recovery tool, not a required ritual.
      if (["retry", "retry-rebased", "retry-with-tools", "fix-forward", "escalate"].includes(choice)) {
        const run = projectRun(journal, runId);
        if (run) {
          const campaignId = campaignOf(journal, runId);
          if (campaignId) detachedKraken(["campaign-adv", campaignId]);
          else detachedKraken(["exec", runId, "--repo", run.repoPath]);
        }
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    } else if (url.pathname === "/api/diff") {
      const runId = url.searchParams.get("runId") ?? "";
      const contractId = url.searchParams.get("contractId") ?? "";
      const run = projectRun(journal, runId);
      const view = run?.contracts.get(contractId);
      if (!run || !view) { res.writeHead(404); res.end("unknown run/contract"); return; }
      const config = loadConfig(run.repoPath);
      const branch = view.branch ?? `kraken/${contractId}`;
      const diff = await git(run.repoPath, ["diff", `${config.trunk}...${branch}`]);
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.end(diff.ok ? diff.stdout : `no diff available: ${diff.stderr}`);
    } else if (url.pathname === "/api/ask" && req.method === "POST") {
      const { runId, question } = JSON.parse(await readBody(req)) as { runId: string; question: string };
      const run = projectRun(journal, runId);
      if (!run) { res.writeHead(404); res.end(); return; }
      const contracts = [...run.contracts.values()]
        .map((c) => `- ${c.contract.id}: ${c.status}${c.lastJudgeScore !== undefined ? ` (judge ${c.lastJudgeScore})` : ""}${c.currentActivity ? ` — now: ${c.currentActivity}` : ""}${c.ejectReason ? ` — ejected: ${c.ejectReason.slice(0, 200)}` : ""}`)
        .join("\n");
      const recent = journal.read({ runId }).slice(-40)
        .map((s) => `${s.event.type}${"contractId" in s.event ? ` ${(s.event as { contractId?: string }).contractId ?? ""}` : ""}`)
        .join(", ");
      const prompt = [
        "You are the supervisor's assistant for a coding-agent fleet run. Answer the question",
        "concisely using the run state below; you may READ files in the current repository for",
        "detail (branches kraken/* hold the arms' work) but change nothing.",
        `## Run ${run.runId} — goal\n${run.goal}`,
        `## Contracts\n${contracts}`,
        `## Recent events\n${recent}`,
        `## Question\n${question}`,
      ].join("\n\n");
      const arm = new ClaudeArm({ permissionMode: "plan", timeoutMs: 4 * 60 * 1000 });
      const result = await arm.dispatch({
        contract: {
          id: `ask-${runId}`, runId, objective: prompt, outputFormat: "concise answer",
          boundaries: { ownsPaths: ["<ask>"], mustNotTouch: [] }, skills: [],
          budget: { maxTokens: 30_000, maxToolCalls: 20 }, modelTier: "standard",
          checkpoints: [{ id: "a", expectedState: "answered", gates: [] }], dependsOn: [],
        },
        worktree: run.repoPath, skillBlock: "", findingsBlock: "", modelTier: "standard", raw: true,
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ answer: result.output.slice(0, 8000), ok: result.ok }));
    } else if (url.pathname === "/api/chat" && req.method === "POST") {
      const { repo, message } = JSON.parse(await readBody(req)) as { repo: string; message: string };
      const chatId = `chat:${repo}`;
      journal.append({ type: "ChatMessage", runId: chatId, role: "user", text: message });
      const runIds = [...new Set(journal.read().map((s) => s.event.runId))].filter((id) => !id.startsWith("chat:") && !id.startsWith("project:"));
      const runLines: string[] = [];
      for (const id of runIds) {
        const run = projectRun(journal, id);
        if (!run || run.repoPath !== repo) continue;
        const tasks = [...run.contracts.values()]
          .map((c) => `  - ${c.contract.id}: ${c.status}${c.lastJudgeScore !== undefined ? ` (judge ${c.lastJudgeScore.toFixed(2)})` : ""}${c.ejectReason ? ` — ejected: ${c.ejectReason.slice(0, 120)}` : ""}`)
          .join("\n");
        runLines.push(`- ${run.title ? `"${run.title}" — ` : ""}${run.goal.slice(0, 200)} → ${run.outcome ?? "open"}${tasks ? `\n${tasks}` : ""}`);
      }
      const tail = journal.read({ runId: chatId })
        .flatMap((s) => (s.event.type === "ChatMessage" ? [s.event] : []))
        .slice(0, -1) // the new message goes in its own section below
        .slice(-14)
        .map((m) => `${m.role}: ${m.text}`)
        .join("\n");
      const prompt = [
        "You are the project channel for a coding-agent fleet: a read-and-plan agent. You may",
        "READ files in this repository to ground your answers, but change nothing — your only",
        "outputs are answers and proposals. When the conversation converges on concrete",
        "actionable work, draft a plan proposal; the fleet executes it after human review.",
        `## Repository\n${repo}`,
        `## Recent runs in this project\n${runLines.slice(-5).join("\n") || "(none yet)"}`,
        ...(tail ? [`## Conversation so far\n${tail}`] : []),
        `## New message\n${message}`,
        'Reply with ONLY JSON: {"reply": "<markdown answer: blank-line paragraphs, lists as lines starting with - , inline `code`/**bold**>", "proposal": {"title": "<4-7 words>", "goal": "<complete self-contained goal for the planner: intent, constraints, done-looks-like>", "why": "<one sentence>"}}',
        'Include "proposal" ONLY when the conversation has converged on concrete actionable work — otherwise omit the key entirely. A proposal goal MUST be executable entirely inside THIS repository. If the work spans repositories, emit instead "campaign": {"title": "<4-7 words>", "intent": "<complete cross-repo intent: what done looks like across all repos, constraints, sequencing facts you learned>", "repos": ["<absolute path>", ...], "why": "<one sentence>"} — list every involved repo by absolute path (siblings live under the same parent directory as this repo); Kraken will chain one run per repo in dependency order.',
      ].join("\n\n");
      const arm = new ClaudeArm({ permissionMode: "plan", timeoutMs: 10 * 60 * 1000 });
      const result = await arm.dispatch({
        contract: {
          id: `chat-${Date.now()}`, runId: chatId, objective: prompt, outputFormat: "JSON reply",
          boundaries: { ownsPaths: ["<chat>"], mustNotTouch: [] }, skills: [],
          budget: { maxTokens: 30_000, maxToolCalls: 20 }, modelTier: "standard",
          checkpoints: [{ id: "a", expectedState: "answered", gates: [] }], dependsOn: [],
        },
        worktree: repo, skillBlock: "", findingsBlock: "", modelTier: "standard", raw: true,
      }, (activity) => journal.append({ type: "ArmActivity", runId: chatId, contractId: "channel", activity }));
      const parsed = result.ok ? parseChatReply(result.output) : null;
      const campaign = parsed?.campaign;
      const reply = parsed?.reply
        ?? (result.ok
          ? result.output.slice(0, 8000)
          : "I hit my time limit mid-investigation and that turn was lost — nothing was saved from it. Ask me to continue and I'll pick the thread back up from what the channel already knows.");
      const proposal = parsed?.proposal;
      journal.append({ type: "ChatMessage", runId: chatId, role: "assistant", text: reply, ...(proposal ? { proposal } : {}), ...(campaign ? { campaign } : {}) });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ reply, proposal, campaign }));
    } else if (url.pathname === "/api/chat") {
      const repo = url.searchParams.get("repo") ?? "";
      const messages = journal.read({ runId: `chat:${repo}` })
        .flatMap((s) => (s.event.type === "ChatMessage"
          ? [{ role: s.event.role, text: s.event.text, proposal: s.event.proposal ?? null, campaign: s.event.campaign ?? null, at: s.at }]
          : []));
      res.writeHead(200, { "content-type": "application/json" });
      const lastMsgAt = messages.length ? messages[messages.length - 1]!.at : "";
      const acts = journal.read({ runId: `chat:${repo}` }).filter((x) => x.event.type === "ArmActivity");
      const lastAct = acts.length ? acts[acts.length - 1]! : null;
      const thinking = lastAct && lastAct.at > lastMsgAt
        ? (lastAct.event as { activity: string }).activity : null;
      res.end(JSON.stringify({ messages, thinking }));
    } else if (url.pathname === "/api/run" && req.method === "POST") {
      const { goal, repo, followUpFrom } = JSON.parse(await readBody(req)) as { goal: string; repo: string; followUpFrom?: string };
      let fullGoal = goal;
      if (followUpFrom) {
        const prior = projectRun(journal, followUpFrom);
        if (prior) {
          const lines = [...prior.contracts.values()].map((c) =>
            `- ${c.contract.id}: ${c.status}${c.lastJudgeScore !== undefined ? ` (judge ${c.lastJudgeScore.toFixed(2)})` : ""}${c.ejectReason ? ` — ejected: ${c.ejectReason.slice(0, 150)}` : ""}${c.report?.summary ? ` — ${c.report.summary.slice(0, 200)}` : ""}`);
          const notes = [...prior.decisions.values()].map((d) => d.annotation).filter((a): a is string => !!a).map((a) => `- ${a.slice(0, 200)}`);
          fullGoal = [
            `Follow-up to a previous run${prior.title ? ` ("${prior.title}")` : ""} in this repo.`,
            `## Previous goal\n${prior.goal.slice(0, 1500)}`,
            `## What happened (${prior.outcome ?? "unresolved"})\n${lines.join("\n") || "(no tasks were planned)"}`,
            ...(notes.length ? [`## Reviewer notes from that run\n${notes.join("\n")}`] : []),
            `## New instruction — plan for THIS\n${goal}`,
          ].join("\n\n");
        }
      }
      detachedKraken(["run", fullGoal, "--repo", repo]);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, planning: true }));
    } else if (url.pathname === "/api/campaign" && req.method === "POST") {
      const { intent, repos } = JSON.parse(await readBody(req)) as { intent: string; repos: string[] };
      detachedKraken(["campaign", intent, "--repos", repos.join(",")]);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, planning: true }));
    } else if (url.pathname === "/api/campaign/advance" && req.method === "POST") {
      const { id } = JSON.parse(await readBody(req)) as { id: string };
      detachedKraken(["campaign-adv", id]);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, advancing: true }));
    } else if (url.pathname === "/api/campaign/abort" && req.method === "POST") {
      const { id } = JSON.parse(await readBody(req)) as { id: string };
      const key = `campaign:${id}`;
      const campaign = projectCampaign(journal, key);
      if (!campaign) { res.writeHead(404); res.end(); return; }
      // Idempotent: a finished campaign (any outcome) is left as it settled.
      if (!campaign.outcome) journal.append({ type: "CampaignCompleted", runId: key, outcome: "aborted" });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, aborted: true }));
    } else if (url.pathname === "/api/exec" && req.method === "POST") {
      const { runId } = JSON.parse(await readBody(req)) as { runId: string };
      const run = projectRun(journal, runId);
      if (!run) { res.writeHead(404); res.end(); return; }
      detachedKraken(["exec", runId, "--repo", run.repoPath]);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, executing: true }));
    } else {
      res.writeHead(404);
      res.end();
    }
  }

  server.listen(port, () => {
    console.log(`⚓ bridge at http://localhost:${port} — put it on your tailnet and pin it to your phone`);
  });
}

/** Plan/exec are long LLM jobs — spawn them detached so the bridge stays responsive. */
function detachedKraken(args: string[]): void {
  const cli = fileURLToPath(new URL("./index.ts", import.meta.url));
  const log = openSync(join(krakenHome(), "jobs.log"), "a");
  const child = spawn(process.execPath, ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", cli, ...args], {
    detached: true, stdio: ["ignore", log, log], env: { ...process.env },
  });
  child.unref();
}

/** The campaign a run is linked to, if any — scanned from CampaignRunLinked events. */
function campaignOf(journal: Journal, childRunId: string): string | null {
  for (const s of journal.read()) {
    if (s.event.type === "CampaignRunLinked" && s.event.childRunId === childRunId) {
      return s.event.runId.replace(/^campaign:/, "");
    }
  }
  return null;
}

function state(journal: Journal) {
  const events = journal.read();
  const runIds = [...new Set(events.map((s) => s.event.runId))]
    .filter((id) => !id.startsWith("chat:") && !id.startsWith("project:") && !id.startsWith("campaign:"))
    .slice(-6).reverse();
  const campaignByRun = new Map<string, string>();
  for (const s of events) {
    if (s.event.type === "CampaignRunLinked") campaignByRun.set(s.event.childRunId, s.event.runId.replace(/^campaign:/, ""));
  }
  const campaignKeys = [...new Set(events.filter((s) => s.event.runId.startsWith("campaign:")).map((s) => s.event.runId))]
    .slice(-4).reverse();
  const attempts = new Map<string, number>();
  const feed = events
    .filter((s) => s.event.type !== "ArmActivity")
    .slice(-60)
    .map((s) => {
      if (s.event.type === "ContractDispatched") {
        const k = `${s.event.runId}/${s.event.contractId}`;
        attempts.set(k, (attempts.get(k) ?? 0) + 1);
        return { at: s.at, text: humanize(s.event, attempts.get(k)!), level: level(s.event) };
      }
      return { at: s.at, text: humanize(s.event), level: level(s.event) };
    })
    .filter((f) => f.text)
    .reverse();
  const activityByContract = new Map<string, string[]>();
  for (const s of events) {
    if (s.event.type !== "ArmActivity") continue;
    const k = `${s.event.runId}/${s.event.contractId}`;
    const list = activityByContract.get(k) ?? [];
    list.push(s.event.activity);
    activityByContract.set(k, list.slice(-14));
  }
  return {
    projects: [...new Set(events.filter((e) => e.event.type === "ProjectOnboarded").map((e) => (e.event as { repoPath: string }).repoPath))],
    decisions: pendingDecisions(journal),
    campaigns: campaignKeys.map((k) => projectCampaign(journal, k)).filter(Boolean),
    feed,
    runs: runIds.map((id) => {
      const run = projectRun(journal, id);
      if (!run) return null;
      return {
        runId: run.runId,
        goal: run.goal,
        title: run.title ?? null,
        brief: run.brief ?? null,
        approved: run.planApproved,
        outcome: run.outcome ?? null,
        repo: run.repoPath,
        campaign: campaignByRun.get(run.runId) ?? null,
        contracts: [...run.contracts.values()].map((c) => ({
          id: c.contract.id,
          status: c.status,
          tier: c.tier ?? c.contract.modelTier,
          objective: c.contract.objective,
          outputFormat: c.contract.outputFormat,
          keyRisks: c.contract.keyRisks ?? [],
          ownsPaths: c.contract.boundaries.ownsPaths,
          dependsOn: c.contract.dependsOn,
          skills: c.contract.skills,
          branch: c.branch ?? null,
          report: c.report ?? null,
          costUsd: c.costUsd ?? null,
          score: c.lastJudgeScore ?? null,
          rationale: c.lastJudgeRationale?.slice(0, 400) ?? null,
          mustFix: c.lastMustFix ?? [],
          dispatchedAt: c.dispatchedAt ?? null,
          settledAt: c.settledAt ?? null,
          ejectReason: c.ejectReason?.slice(0, 240) ?? null,
          currentActivity: ["dispatched", "at-checkpoint"].includes(c.status) ? (c.currentActivity ?? null) : null,
          activityLog: activityByContract.get(`${run.runId}/${c.contract.id}`) ?? [],
        })),
      };
    }).filter(Boolean),
  };
}

function trim(text: string, max: number): string {
  const t = text
    .replace(/\u001b\[[0-9;]*m/g, "")
    .replace(/gate-failed: gate '([^']+)' failed:\s*·?\s*/g, "gate `$1` → ")
    .replace(/\s+/g, " ")
    .trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const stop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("; "), cut.lastIndexOf(", "));
  return (stop > max * 0.55 ? cut.slice(0, stop + 1) : cut).trim() + " \u2026";
}

function level(e: import("@kraken/core").KrakenEvent): "ok" | "warn" | "bad" | "info" {
  switch (e.type) {
    case "MergeCarMerged": case "ContractCompleted": case "PlanDecision": case "RunCompleted": case "CampaignCompleted": return "ok";
    case "DecisionRequested": case "TierEscalated": return "warn";
    case "MergeCarEjected": return "bad";
    case "CheckpointJudged": return e.pass ? "ok" : "warn";
    case "GateResult": return e.passed ? "info" : "bad";
    default: return "info";
  }
}

function humanize(e: import("@kraken/core").KrakenEvent, attempt = 1): string | null {
  switch (e.type) {
    case "RunStarted": return `run ${e.runId} started: ${e.goal.slice(0, 90)}`;
    case "PlanProposed": return `plan proposed: ${e.contracts.length} tasks (${e.contracts.map((c) => c.id).join(", ")})`;
    case "PlanDecision": return `plan ${e.decision}`;
    case "ContractDispatched": return `${e.contractId} ${attempt > 1 ? `re-dispatched (attempt ${attempt})` : "dispatched"} on ${e.harness} [${e.modelTier}]${e.skillsInjected.length ? " · skills: " + e.skillsInjected.join(", ") : ""}`;
    case "FindingPublished": return `◆ ${e.contractId} published a ${e.kind}: ${trim(e.summary, 160)}`;
    case "FindingRouted": return `↳ finding routed to ${e.toContractIds.join(", ")} (${e.reason.slice(0, 60)})`;
    case "GateResult": return `gate ${e.gate} for ${e.contractId}: ${e.passed ? "pass" : "FAIL"}`;
    case "CheckpointJudged": return `judge ${e.contractId}: ${e.pass ? "PASS" : "FAIL"} ${e.score.toFixed(2)} — ${trim(e.rationale, 200)}`;
    case "TierEscalated": return `⇧ ${e.contractId} escalated ${e.from} → ${e.to}: ${trim(e.reason, 140)}`;
    case "DecisionRequested": return `⚑ decision needed: ${trim(e.question, 160)}`;
    case "DecisionMade": return `✓ ${e.decidedBy === "kraken" ? "kraken auto-resolved" : `decided by ${e.decidedBy}`}: ${e.decisionId} → ${e.choice}${e.annotation ? " (" + e.annotation.slice(0, 60) + ")" : ""}`;
    case "ContractCompleted": return `${e.contractId} completed on ${e.branch}${e.costUsd ? ` · $${e.costUsd.toFixed(2)}` : ""}`;
    case "MergeCarQueued": return `⊕ ${e.contractId} queued on the train`;
    case "MergeCarMerged": return `✔ ${e.contractId} merged (${e.commit.slice(0, 8)})`;
    case "MergeCarEjected": return `✖ ${e.contractId} ejected: ${trim(e.reason, 220)}`;
    case "RunCompleted": return `run ${e.runId} finished: ${e.outcome}`;
    case "CampaignStarted": return `campaign ${e.runId.replace(/^campaign:/, "")} started: ${e.title} (${e.slices.length} repos)`;
    case "CampaignRunLinked": return `campaign ${e.runId.replace(/^campaign:/, "")}: run ${e.childRunId} planned for ${e.repo.split("/").pop()}`;
    case "CampaignCompleted": return `campaign ${e.runId.replace(/^campaign:/, "")} finished: ${e.outcome}`;
    default: return null;
  }
}

/** Balanced-brace scan for the chat reply JSON — model output is prose-adjacent, never regex it. */
function parseChatReply(output: string): { reply: string; proposal?: { title: string; goal: string; why: string }; campaign?: { title: string; intent: string; repos: string[]; why: string } } | null {
  const start = output.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < output.length; i++) {
    const ch = output[i];
    if (escaped) { escaped = false; continue; }
    if (ch === "\\") { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === "{") depth++;
    if (ch === "}") depth--;
    if (depth === 0) {
      try {
        const raw = JSON.parse(output.slice(start, i + 1)) as Record<string, unknown>;
        if (typeof raw.reply !== "string") return null;
        const p = raw.proposal as Record<string, unknown> | undefined;
        const c = raw.campaign as Record<string, unknown> | undefined;
        const campaign = c && typeof c.title === "string" && typeof c.intent === "string" && Array.isArray(c.repos)
          ? { title: c.title, intent: c.intent, repos: (c.repos as unknown[]).map(String), why: String(c.why ?? "") }
          : undefined;
        const proposal = p && typeof p.title === "string" && typeof p.goal === "string"
          ? { title: p.title, goal: p.goal, why: String(p.why ?? "") }
          : undefined;
        return { reply: raw.reply, ...(proposal ? { proposal } : {}), ...(campaign ? { campaign } : {}) };
      } catch {
        return null;
      }
    }
  }
  return null;
}

function lastSeq(journal: Journal): number {
  const events = journal.read();
  return events.length ? events[events.length - 1]!.seq : 0;
}

function readBody(req: import("node:http").IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (d: Buffer) => (body += d.toString()));
    req.on("end", () => resolve(body));
  });
}

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Kraken — bridge</title>
<style>body{font-family:ui-monospace,monospace;background:#f9fafb;color:#111827;display:grid;place-items:center;height:100dvh;margin:0}
main{text-align:center}code{background:#f3f4f6;padding:2px 6px;border-radius:4px}</style></head>
<body><main><p><strong>Kraken bridge is not built.</strong></p>
<p>Run <code>pnpm --filter @kraken/bridge build</code>, then reload.</p></main></body></html>`;
