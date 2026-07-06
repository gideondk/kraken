export interface ContractState {
  id: string;
  status: string;
  tier: string;
  objective: string;
  outputFormat: string;
  keyRisks: string[];
  ownsPaths: string[];
  dependsOn: string[];
  skills: string[];
  branch: string | null;
  report: {
    summary: string; filesTouched: string[]; decisions: string[]; gotchas: string[];
    interfaceChanges: string[]; blockers: string[]; confidence: number;
  } | null;
  costUsd: number | null;
  score: number | null;
  rationale: string | null;
  mustFix: string[];
  dispatchedAt: string | null;
  settledAt: string | null;
  ejectReason: string | null;
  currentActivity: string | null;
  activityLog: string[];
}

export interface RunState {
  runId: string;
  goal: string;
  title: string | null;
  brief: { objectives: string[]; constraints: string[]; doneWhen: string[] } | null;
  repo: string;
  approved: boolean;
  outcome: string | null;
  /** Campaign id when this run is a campaign slice — approval then auto-advances the DAG. */
  campaign: string | null;
  contracts: ContractState[];
}

export interface CampaignSlice {
  repo: string;
  goal: string;
  dependsOn: string[];
  childRunId?: string;
  childOutcome?: string;
  /** pending | planning | plan review | running | success | partial | … */
  childStatus: string;
}

export interface Campaign {
  planning: boolean;
  id: string;
  intent: string;
  title: string;
  outcome?: "success" | "partial" | "aborted";
  slices: CampaignSlice[];
}

export interface Decision {
  runId: string;
  decisionId: string;
  contractId: string | null;
  question: string;
  options: string[];
  context: string;
  /** When the decision was requested — the inbox shows waiting time. */
  at: string;
  /** The run's repository — the inbox groups by project basename. */
  repoPath: string;
  suggestedTools?: string[];
}

export interface HelmState {
  projects: string[];
  decisions: Decision[];
  campaigns: Campaign[];
  feed: { at: string; text: string; level: "ok" | "warn" | "bad" | "info" }[];
  runs: RunState[];
}

export const fetchState = (): Promise<HelmState> =>
  fetch("/api/state").then((r) => r.json());

export const fetchDiff = (runId: string, contractId: string): Promise<string> =>
  fetch(`/api/diff?runId=${runId}&contractId=${contractId}`).then((r) => r.text());

// decidedBy is forwarded verbatim — the server stamps "bridge" only when the caller
// names nobody. Dropping it here is how agent-driven decisions got misattributed.
export const decide = (runId: string, decisionId: string, choice: string, annotation?: string, decidedBy?: string) =>
  fetch("/api/decide", { method: "POST", body: JSON.stringify({ runId, decisionId, choice, annotation, decidedBy }) });

export const startRun = (goal: string, repo: string, followUpFrom?: string) =>
  fetch("/api/run", { method: "POST", body: JSON.stringify({ goal, repo, followUpFrom }) });

export const ask = (runId: string, question: string): Promise<{ answer: string; ok: boolean }> =>
  fetch("/api/ask", { method: "POST", body: JSON.stringify({ runId, question }) }).then((r) => r.json());

export interface ChatMsg {
  role: "user" | "assistant";
  text: string;
  proposal: { title: string; goal: string; why: string } | null;
  campaign: { title: string; intent: string; repos: string[]; why: string } | null;
  at: string;
}

export const fetchChat = (repo: string): Promise<{ messages: ChatMsg[]; thinking: string | null }> =>
  fetch(`/api/chat?repo=${encodeURIComponent(repo)}`).then((r) => r.json());

export const sendChat = (repo: string, message: string): Promise<{ reply: string; proposal?: ChatMsg["proposal"] }> =>
  fetch("/api/chat", { method: "POST", body: JSON.stringify({ repo, message }) }).then((r) => r.json());

export const execRun = (runId: string) =>
  fetch("/api/exec", { method: "POST", body: JSON.stringify({ runId }) });

export const startCampaign = (intent: string, repos: string[]) =>
  fetch("/api/campaign", { method: "POST", body: JSON.stringify({ intent, repos }) });

export const advanceCampaign = (id: string) =>
  fetch("/api/campaign/advance", { method: "POST", body: JSON.stringify({ id }) });

export const abortCampaign = (id: string) =>
  fetch("/api/campaign/abort", { method: "POST", body: JSON.stringify({ id }) });

/** Topological waves from dependsOn — mirrors the reconciler's scheduling. */
export function waves(contracts: ContractState[]): ContractState[][] {
  const remaining = new Map(contracts.map((c) => [c.id, c]));
  const done = new Set<string>();
  const result: ContractState[][] = [];
  while (remaining.size > 0) {
    const wave = [...remaining.values()].filter((c) =>
      c.dependsOn.every((d) => done.has(d) || !remaining.has(d)),
    );
    if (wave.length === 0) break;
    for (const c of wave) {
      remaining.delete(c.id);
      done.add(c.id);
    }
    result.push(wave);
  }
  return result;
}

export const elapsed = (c: ContractState): string => {
  if (!c.dispatchedAt) return "";
  const end = c.settledAt ? new Date(c.settledAt).getTime() : Date.now();
  const m = Math.round((end - new Date(c.dispatchedAt).getTime()) / 60000);
  return m < 1 ? "<1m" : `${m}m`;
};
