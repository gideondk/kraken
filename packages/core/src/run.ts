import type { Journal } from "./journal.ts";
import type { TaskContract } from "./contract.ts";
import type { RunBrief, WorkerReport } from "./events.ts";
import type { StoredEvent } from "./events.ts";

export interface ContractView {
  contract: TaskContract;
  status:
    | "planned"
    | "dispatched"
    | "at-checkpoint"
    | "awaiting-decision"
    | "completed"
    | "queued"
    | "merged"
    | "ejected"
    | "parked";
  armId?: string;
  branch?: string;
  lastJudgeScore?: number;
  lastJudgeRationale?: string;
  lastMustFix?: string[];
  costUsd?: number;
  report?: WorkerReport;
  currentActivity?: string;
  tier?: string;
  dispatchedAt?: string;
  settledAt?: string;
  ejectReason?: string;
}

export interface DecisionView {
  runId: string;
  decisionId: string;
  contractId: string | null;
  question: string;
  options: string[];
  context: string;
  /** Journal stamp of the DecisionRequested event — inboxes show age from this. */
  at: string;
  /** The run's repository — decision inboxes group by project. */
  repoPath: string;
  resolved: boolean;
  choice?: string;
  annotation?: string;
  /** Who resolved it — "kraken" marks machine auto-resolutions (auto-heal, stale-decision cleanup). */
  decidedBy?: string;
  /** Tool grants offered with a retry-with-tools option (auditable escalation). */
  suggestedTools?: string[];
}

export interface RunView {
  runId: string;
  goal: string;
  title?: string;
  brief?: RunBrief;
  repoPath: string;
  planApproved: boolean;
  contracts: Map<string, ContractView>;
  decisions: Map<string, DecisionView>;
  outcome?: "success" | "partial" | "aborted" | "declined" | "replanned";
}

/** Projection: the current state of a run, folded from its journal. */
export function projectRun(journal: Journal, runId: string): RunView | null {
  const view = journal.project<RunView | null>(null, foldRun, { runId });
  return view;
}

export function foldRun(state: RunView | null, stored: StoredEvent): RunView | null {
  const { event: e, at } = stored;
  switch (e.type) {
    case "RunStarted":
      return {
        runId: e.runId,
        goal: e.goal,
        repoPath: e.repoPath,
        planApproved: false,
        contracts: new Map(),
        decisions: new Map(),
      };
  }
  if (!state) return state;
  const contract = (id: string) => state.contracts.get(id);
  switch (e.type) {
    case "PlanProposed":
      for (const c of e.contracts) state.contracts.set(c.id, { contract: c, status: "planned" });
      if (e.title) state.title = e.title;
      if (e.brief) state.brief = e.brief;
      break;
    case "PlanDecision":
      if (e.decision === "rejected" && state.outcome !== "replanned") state.outcome = "declined";
      state.planApproved = e.decision === "approved";
      break;
    case "ContractDispatched": {
      const c = contract(e.contractId);
      if (c) Object.assign(c, { status: "dispatched", armId: e.armId, tier: e.modelTier, dispatchedAt: at });
      break;
    }
    case "ArmActivity": {
      const c = contract(e.contractId);
      if (c) c.currentActivity = e.activity;
      break;
    }
    case "CheckpointReached": {
      const c = contract(e.contractId);
      if (c) { c.status = "at-checkpoint"; c.currentActivity = "judging checkpoint"; }
      break;
    }
    case "CheckpointJudged": {
      const c = contract(e.contractId);
      if (c) {
        c.lastJudgeScore = e.score;
        c.lastJudgeRationale = e.rationale;
        c.lastMustFix = e.mustFix ?? [];
        if (e.pass) c.status = "dispatched";
      }
      break;
    }
    case "DecisionRequested":
      state.decisions.set(e.decisionId, {
        runId: e.runId,
        decisionId: e.decisionId,
        contractId: e.contractId,
        question: e.question,
        options: e.options,
        context: e.context,
        at,
        repoPath: state.repoPath,
        resolved: false,
       ...(e.suggestedTools ? { suggestedTools: e.suggestedTools } : {}) });
      if (e.contractId) {
        const c = contract(e.contractId);
        if (c) c.status = "awaiting-decision";
      }
      break;
    case "DecisionMade": {
      if (e.decisionId.startsWith("plan-") && e.choice === "replan") state.outcome = "replanned";
      const d = state.decisions.get(e.decisionId);
      if (d) {
        d.resolved = true;
        d.choice = e.choice;
        d.decidedBy = e.decidedBy;
        if (e.annotation) d.annotation = e.annotation;
        if (d.contractId) {
          const c = contract(d.contractId);
          if (c) {
            // Decision semantics: park shelves the contract; retry/escalate/
            // retry-rebased hand it back to the reconciler as plannable work.
            if (e.choice === "park") c.status = "parked";
            else if (["retry", "escalate", "retry-rebased", "fix-forward", "retry-with-tools"].includes(e.choice)) c.status = "planned";
            else if (c.status === "awaiting-decision") c.status = "dispatched";
          }
        }
      }
      break;
    }
    case "ContractCompleted": {
      const c = contract(e.contractId);
      if (c) {
        Object.assign(c, { status: "completed", branch: e.branch, settledAt: at });
        if (e.costUsd !== undefined) c.costUsd = e.costUsd;
        if (e.report) c.report = e.report;
      }
      break;
    }
    case "MergeCarQueued": {
      const c = contract(e.contractId);
      if (c) c.status = "queued";
      break;
    }
    case "MergeCarMerged": {
      const c = contract(e.contractId);
      if (c) c.status = "merged";
      break;
    }
    case "MergeCarEjected": {
      const c = contract(e.contractId);
      if (c) Object.assign(c, { status: "ejected", ejectReason: e.reason });
      break;
    }
    case "RunCompleted":
      state.outcome = e.outcome;
      break;
  }
  return state;
}

/** Pending decisions across all runs — the phone's home screen. */
export function pendingDecisions(journal: Journal): DecisionView[] {
  const runIds = new Set(journal.read().map((s) => s.event.runId));
  const pending: DecisionView[] = [];
  for (const runId of runIds) {
    // Pseudo-runs (channels, project registrations, campaigns) carry no decisions of their own.
    if (runId.startsWith("chat:") || runId.startsWith("project:") || runId.startsWith("campaign:")) continue;
    const run = projectRun(journal, runId);
    if (!run || run.outcome) continue;
    for (const d of run.decisions.values()) if (!d.resolved) pending.push(d);
  }
  return pending;
}

/* ---------- campaigns: one intent, N single-repo runs chained in dependency order ---------- */

export interface CampaignSliceView {
  repo: string;
  goal: string;
  /** Repo paths of sibling slices whose runs must succeed before this one plans. */
  dependsOn: string[];
  childRunId?: string;
  childOutcome?: "success" | "partial" | "aborted" | "declined" | "replanned";
  /** "pending" until linked; then the child run's lifecycle: planning | plan review | running | <outcome>. */
  childStatus: string;
}

export interface CampaignView {
  id: string;
  intent: string;
  title: string;
  slices: CampaignSliceView[];
  /** True from kickoff until the campaign planner returns a DAG. */
  planning: boolean;
  outcome?: "success" | "partial" | "aborted";
}

/** Projection: current state of a campaign, folded from its journal key ("campaign:<id>"). */
export function projectCampaign(journal: Journal, campaignKey: string): CampaignView | null {
  let view: CampaignView | null = null;
  const linked = new Map<string, string>(); // repo → childRunId
  for (const stored of journal.read({ runId: campaignKey })) {
    const e = stored.event;
    if (e.type === "CampaignPlanning") {
      view = {
        id: campaignKey.replace(/^campaign:/, ""),
        intent: e.intent,
        title: e.intent.slice(0, 60) + (e.intent.length > 60 ? "\u2026" : ""),
        slices: [],
        planning: true,
      };
    } else if (e.type === "CampaignStarted") {
      view = {
        id: campaignKey.replace(/^campaign:/, ""),
        intent: e.intent,
        title: e.title,
        slices: e.slices.map((s) => ({ repo: s.repo, goal: s.goal, dependsOn: s.dependsOn, childStatus: "pending" })),
        planning: false,
      };
    } else if (e.type === "CampaignRunLinked") {
      linked.set(e.repo, e.childRunId);
    } else if (e.type === "CampaignCompleted" && view) {
      view.outcome = e.outcome;
    }
  }
  if (!view) return null;
  for (const slice of view.slices) {
    const childRunId = linked.get(slice.repo);
    if (!childRunId) continue;
    slice.childRunId = childRunId;
    const run = projectRun(journal, childRunId);
    if (!run) { slice.childStatus = "planning"; continue; }
    if (run.outcome) {
      slice.childOutcome = run.outcome;
      slice.childStatus = run.outcome;
    } else {
      slice.childStatus = run.contracts.size === 0 ? "planning" : run.planApproved ? "running" : "plan review";
    }
  }
  return view;
}
