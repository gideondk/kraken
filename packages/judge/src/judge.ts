import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { CheckpointSpec, ModelTier, TaskContract } from "@kraken/core";
import type { Arm } from "@kraken/arms";
import { git } from "@kraken/train";

const execFileP = promisify(execFile);

/**
 * Checkpoint evaluation, in the measured-most-consistent shape: execution
 * gates first (evidence beats opinion), then ONE LLM call scoring 0-1 with
 * pass/fail against the contract — end-state, not process conformance.
 */
export interface Verdict {
  score: number;
  pass: boolean;
  rationale: string;
  /** Concrete, actionable fixes — feed escalation retries and fix-forward arms. */
  mustFix: string[];
}

export interface GateOutcome {
  gate: string;
  passed: boolean;
  output: string;
}

export interface CheckpointResult {
  gates: GateOutcome[];
  verdict: Verdict;
}

/** fast → standard → frontier. Null when the ladder is exhausted. */
export function nextTier(tier: ModelTier): ModelTier | null {
  if (tier === "fast") return "standard";
  if (tier === "standard") return "frontier";
  return null;
}

export function renderJudgePrompt(
  contract: TaskContract,
  checkpoint: CheckpointSpec,
  diff: string,
  gates: GateOutcome[],
  workerSummary: string,
): string {
  const gateReport = gates.length
    ? gates.map((g) => `- ${g.gate}: ${g.passed ? "PASS" : `FAIL\n${g.output.slice(-800)}`}`).join("\n")
    : "(no execution gates configured)";
  return `You are the judge for a coding-agent fleet. Evaluate whether this worker's
output achieves the contract's end state. Judge the final state, not the process.
Execution gate results are evidence and outrank your own impression. If the
contract involves external side effects (PR comments, API state) and you have
the tools to check them (e.g. gh), VERIFY them yourself before ruling them
unevidenced.

## Contract
Objective: ${contract.objective}
Expected state at this checkpoint: ${checkpoint.expectedState}
Output format required: ${contract.outputFormat}
Owned paths: ${contract.boundaries.ownsPaths.join(", ")}
Must not touch: ${contract.boundaries.mustNotTouch.join(", ") || "(none)"}

## Execution gates
${gateReport}

## Worker's summary
${workerSummary.slice(0, 3000)}

## Diff (worker branch vs trunk, truncated)
${diff.slice(0, 20000)}

Reply with ONLY a JSON object:
{"score": <0.0-1.0>, "pass": <true|false>, "rationale": "<2-4 sentences: what is right, what is wrong>",
 "mustFix": ["<concrete actionable fix, one per item; wrap any command or file path in backticks; empty when pass=true>"]}
Rules: any failed execution gate means pass=false. Writes outside owned paths
mean pass=false. Score < 0.7 means pass=false.`;
}

export function parseVerdict(output: string): Verdict | null {
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
        const score = Number(raw.score);
        if (Number.isNaN(score)) return null;
        return {
          score: Math.min(1, Math.max(0, score)),
          pass: raw.pass === true,
          rationale: String(raw.rationale ?? ""),
          mustFix: Array.isArray(raw.mustFix) ? raw.mustFix.map(String).filter(Boolean) : [],
        };
      } catch {
        return null;
      }
    }
  }
  return null;
}

/** Run the checkpoint's execution gates inside the worker's worktree. */
export async function runCheckpointGates(
  worktree: string,
  gates: string[],
): Promise<GateOutcome[]> {
  const outcomes: GateOutcome[] = [];
  for (const gate of gates) {
    const [cmd, ...args] = gate.split(" ");
    try {
      const { stdout, stderr } = await execFileP(cmd!, args, {
        cwd: worktree,
        timeout: 600_000,
        maxBuffer: 32 * 1024 * 1024,
      });
      outcomes.push({ gate, passed: true, output: `${stdout}\n${stderr}`.trim() });
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; message?: string };
      outcomes.push({
        gate,
        passed: false,
        output: `${e.stdout ?? ""}\n${e.stderr ?? ""}\n${e.message ?? ""}`.trim(),
      });
    }
  }
  return outcomes;
}

export async function judgeCheckpoint(opts: {
  arm: Arm;
  contract: TaskContract;
  checkpoint: CheckpointSpec;
  worktree: string;
  trunk: string;
  workerSummary: string;
  /** Model tier used for the judge call itself. Cheap by default; the rubric does the work. */
  judgeTier?: ModelTier;
  /** Tool grants the worker had — the judge gets the same, so it can verify external side effects itself. */
  allowedTools?: string[];
}): Promise<CheckpointResult> {
  const gates = await runCheckpointGates(opts.worktree, opts.checkpoint.gates);
  const diffRes = await git(opts.worktree, ["diff", `${opts.trunk}...HEAD`, "--stat", "-p"]);
  const prompt = renderJudgePrompt(opts.contract, opts.checkpoint, diffRes.stdout, gates, opts.workerSummary);

  const result = await opts.arm.dispatch({
    contract: { ...opts.contract, objective: prompt },
    worktree: opts.worktree,
    skillBlock: "",
    findingsBlock: "",
    modelTier: opts.judgeTier ?? "fast",
    ...(opts.allowedTools?.length ? { allowedTools: opts.allowedTools } : {}),
    raw: true,
  });

  const parsed = result.ok ? parseVerdict(result.output) : null;
  const gatesFailed = gates.some((g) => !g.passed);
  const verdict: Verdict = parsed
    ? { ...parsed, pass: parsed.pass && !gatesFailed }
    : {
        score: gatesFailed ? 0 : 0.5,
        pass: false,
        rationale: `judge call ${result.ok ? "returned unparseable verdict" : "failed"}: ${result.output.slice(0, 300)}`,
        mustFix: gates.filter((g) => !g.passed).map((g) => `make gate '${g.gate}' pass`),
      };
  return { gates, verdict };
}
