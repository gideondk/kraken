import type { ModelTier, TaskContract } from "./contract.ts";

/**
 * Every fact in a run is an append-only event. The journal is simultaneously:
 * resume state (replay), the audit trail (evidence per merge), and the source
 * for helm projections. Nothing mutates; supersession is a new event.
 */
export type KrakenEvent =
  | { type: "RunStarted"; runId: string; goal: string; repoPath: string }
  | { type: "PlanProposed"; runId: string; contracts: TaskContract[]; title?: string; brief?: RunBrief }
  | { type: "PlanDecision"; runId: string; decision: "approved" | "rejected"; annotations: string[] }
  | { type: "ContractDispatched"; runId: string; contractId: string; armId: string; harness: string; modelTier: ModelTier; worktree: string; skillsInjected: string[] }
  | { type: "FindingPublished"; runId: string; contractId: string; findingId: string; kind: FindingKind; summary: string; paths: string[]; tags: string[] }
  | { type: "FindingRouted"; runId: string; findingId: string; toContractIds: string[]; reason: string }
  | { type: "ArmActivity"; runId: string; contractId: string; activity: string }
  | { type: "CheckpointReached"; runId: string; contractId: string; checkpointId: string }
  | { type: "GateResult"; runId: string; contractId: string; checkpointId: string; gate: string; passed: boolean; output: string }
  | { type: "CheckpointJudged"; runId: string; contractId: string; checkpointId: string; score: number; pass: boolean; rationale: string; mustFix?: string[] }
  | { type: "TierEscalated"; runId: string; contractId: string; from: ModelTier; to: ModelTier; reason: string }
  | { type: "DecisionRequested"; runId: string; decisionId: string; contractId: string | null; question: string; options: string[]; context: string; suggestedTools?: string[] }
  | { type: "DecisionMade"; runId: string; decisionId: string; choice: string; annotation: string; decidedBy: string }
  | { type: "ContractCompleted"; runId: string; contractId: string; branch: string; summary: string; costUsd?: number; report?: WorkerReport }
  | { type: "MergeCarQueued"; runId: string; contractId: string; branch: string }
  | { type: "MergeCarMerged"; runId: string; contractId: string; commit: string }
  | { type: "MergeCarEjected"; runId: string; contractId: string; reason: string }
  | { type: "RunCompleted"; runId: string; outcome: "success" | "partial" | "aborted" }
  // Project chat: runId is "chat:" + repoPath — a channel per repo, outliving runs.
  | { type: "ProjectOnboarded"; runId: string; repoPath: string }
  | { type: "ChatMessage"; runId: string; role: "user" | "assistant"; text: string; proposal?: { title: string; goal: string; why: string }; campaign?: { title: string; intent: string; repos: string[]; why: string } }
  // Campaigns: one intent, N single-repo runs chained in dependency order.
  // runId is "campaign:<8-hex-id>"; dependsOn entries are repo paths of sibling slices.
  | { type: "CampaignPlanning"; runId: string; intent: string; repos: string[] }
  | { type: "CampaignStarted"; runId: string; intent: string; title: string; slices: { repo: string; goal: string; dependsOn: string[] }[] }
  | { type: "CampaignRunLinked"; runId: string; repo: string; childRunId: string }
  | { type: "CampaignCompleted"; runId: string; outcome: "success" | "partial" | "aborted" };

export type FindingKind = "decision" | "gotcha" | "interface-change" | "blocker";

/** The planner's normalized reading of the goal — what renders instead of prompt prose. */
export interface RunBrief {
  objectives: string[];
  constraints: string[];
  doneWhen: string[];
}

/** Structured report every arm returns — the contract's other half. */
export interface WorkerReport {
  summary: string;
  filesTouched: string[];
  decisions: string[];
  gotchas: string[];
  interfaceChanges: string[];
  blockers: string[];
  confidence: number;
}

export interface StoredEvent {
  seq: number;
  at: string; // ISO timestamp
  event: KrakenEvent;
}
