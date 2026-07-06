import type { ModelTier, TaskContract } from "@kraken/core";

/**
 * An Arm drives one worker in one harness. Two implementations today:
 * ClaudeArm (headless `claude -p`) and SubprocessArm (any CLI). ACP-backed
 * arms slot in behind the same interface when the protocol is capable enough.
 */
export interface ArmResult {
  ok: boolean;
  /** The worker's final message — its report back to the head. */
  output: string;
  costUsd?: number;
  raw?: unknown;
}

export interface DispatchInput {
  contract: TaskContract;
  /** Absolute path of the worktree this arm owns. */
  worktree: string;
  /** Rendered skill block, prepended to the prompt. */
  skillBlock: string;
  /** Findings from siblings, injected at dispatch (and at checkpoints later). */
  findingsBlock: string;
  modelTier: ModelTier;
  /** Extra tool patterns auto-approved for this dispatch (e.g. "Bash(gh pr view:*)"). Journal-auditable grants, not blanket trust. */
  allowedTools?: string[];
  /** Send the objective verbatim — no worker boilerplate. Used by the planner. */
  raw?: boolean;
}

export interface Arm {
  readonly harness: string;
  dispatch(input: DispatchInput, onActivity?: (activity: string) => void): Promise<ArmResult>;
}

/** Model tier → concrete model alias, per harness. Overridable via kraken.toml. */
export type TierMap = Record<ModelTier, string>;

export function renderPrompt(input: DispatchInput): string {
  const c = input.contract;
  if (input.raw) return c.objective;
  return [
    input.skillBlock,
    input.findingsBlock,
    "# Task contract",
    `Objective: ${c.objective}`,
    `Output format: ${c.outputFormat}`,
    `You own these paths (write nowhere else): ${c.boundaries.ownsPaths.join(", ")}`,
    c.boundaries.mustNotTouch.length
      ? `You must NOT touch: ${c.boundaries.mustNotTouch.join(", ")}`
      : "",
    `Budget: ~${c.budget.maxTokens} tokens / ~${c.budget.maxToolCalls} tool calls, and your process is hard-killed after 30 minutes. Pace yourself: when roughly 80% of the budget is spent, STOP investigating and wrap up — finish the most valuable change, then write your report. Unreported work is lost work; a partial result with an honest report beats a perfect result that never gets filed.`,
    "Work in the current directory (it is your isolated worktree). Do NOT run git add/commit — the harness commits for you.",
    "Receipts for side effects: when your contract's deliverables live outside the repo (PR comments posted, APIs called), the judge can only verify what you show — include the verbatim command output proving each external claim in your report's summary or decisions. An external claim without a receipt will be scored as unverified.",
    "Denied tools fail closed: network access and commands like gh are unavailable unless your contract explicitly grants them. If a command is denied, do NOT probe alternatives, retry variants, or reconstruct the missing information by inference — external content you cannot read (PR reviews, API responses) must NEVER appear in your work as assumed fact. Note the exact command you needed in your report's blockers and move on to what you CAN verify.",
    "End your reply with ONLY a JSON object, no code fences, exactly this shape: " +
      '{"summary": "<2-4 sentences: what you did and why>", "filesTouched": ["relative/path"], ' +
      '"decisions": ["<implicit choice siblings must know about>"], "gotchas": ["<surprising constraint discovered>"], ' +
      '"interfaceChanges": ["<new or changed public surface>"], "blockers": ["<work not completed and why>"], "confidence": 0.0}',
  ]
    .filter(Boolean)
    .join("\n\n");
}
