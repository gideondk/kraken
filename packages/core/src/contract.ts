/**
 * The task contract is the unit of delegation. Vague delegation is the #1
 * documented multi-agent failure mode, so every field that shapes worker
 * behaviour is explicit and required — a contract is never a bare task string.
 */
export interface TaskContract {
  id: string;
  runId: string;
  objective: string;
  /** What the worker must hand back, described concretely. */
  outputFormat: string;
  /** Paths / modules this task owns. Writes outside boundaries are a defect. */
  boundaries: {
    ownsPaths: string[];
    mustNotTouch: string[];
  };
  /** Skill names resolved by the router; injected full-content at dispatch. */
  skills: string[];
  /** Hard ceiling. Token spend is a first-class lever, not an afterthought. */
  budget: {
    maxTokens: number;
    maxToolCalls: number;
  };
  /** Model tier to start on. The judge may escalate; the contract records the floor. */
  modelTier: ModelTier;
  /** Planner-flagged risks worth human eyes at review — only for genuinely risky tasks. */
  keyRisks?: string[];
  /** Checkpoints where the judge runs. At minimum one at completion. */
  checkpoints: CheckpointSpec[];
  /** Contracts this one depends on (merge ordering hint for the train). */
  dependsOn: string[];
}

export type ModelTier = "fast" | "standard" | "frontier";

export interface CheckpointSpec {
  id: string;
  /** State the repo/system should be in when this checkpoint fires. */
  expectedState: string;
  /** Execution gates run before any model judgment. Evidence beats opinion. */
  gates: string[];
}

export type ContractProblem = { field: string; message: string };

/** Structural validation. Returns problems instead of throwing: the planner retries. */
export function validateContract(c: TaskContract): ContractProblem[] {
  const problems: ContractProblem[] = [];
  if (!c.objective.trim()) problems.push({ field: "objective", message: "objective is empty" });
  if (c.objective.trim().length < 20)
    problems.push({ field: "objective", message: "objective too vague (< 20 chars)" });
  if (!c.outputFormat.trim())
    problems.push({ field: "outputFormat", message: "output format missing" });
  if (c.boundaries.ownsPaths.length === 0)
    problems.push({ field: "boundaries.ownsPaths", message: "task owns no paths" });
  if (c.budget.maxTokens <= 0)
    problems.push({ field: "budget.maxTokens", message: "budget must be positive" });
  if (c.checkpoints.length === 0)
    problems.push({ field: "checkpoints", message: "at least one checkpoint required" });
  const overlap = c.boundaries.ownsPaths.filter((p) => c.boundaries.mustNotTouch.includes(p));
  if (overlap.length > 0)
    problems.push({
      field: "boundaries",
      message: `paths both owned and forbidden: ${overlap.join(", ")}`,
    });
  return problems;
}
