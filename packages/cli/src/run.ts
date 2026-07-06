import { randomUUID } from "node:crypto";
import type { CampaignSliceView, CampaignView, DecisionView, Journal, ModelTier, RunBrief, TaskContract, WorkerReport } from "@kraken/core";
import { projectCampaign, projectRun, validateContract } from "@kraken/core";
import { FindingsBus } from "@kraken/bus";
import { loadPack, renderSkillBlock, routeSkills, type RoutingRule } from "@kraken/skills";
import { runTrain, type GateSpec } from "@kraken/train";
import {
  ClaudeArm, CodexArm, SubprocessArm, commitArmWork, createArmWorktree, removeArmWorktree,
  type Arm, type SubprocessArmConfig, type TierMap,
} from "@kraken/arms";
import { judgeCheckpoint, nextTier, runCheckpointGates } from "@kraken/judge";
import { loadConfig } from "./config.ts";
import { notify } from "./notify.ts";

export interface RunConfig {
  repo: string;
  trunk: string;
  gates: GateSpec[];
  skillRoots: string[];
  routingRules: RoutingRule[];
  maxParallel: number;
  /** Which arm runs the fleet. "claude" is built in; others come from [[arms]]. */
  defaultArm: string;
  arms: SubprocessArmConfig[];
  /** POSTed on every DecisionRequested — ntfy.sh topic URL or any webhook. */
  notifyUrl?: string;
  allowedTools: string[];
  /** Tier two of the ladder (deterministic → self-heal → judge): mechanical ejections self-heal as fix-forward. */
  autoHeal: boolean;
  /** Heal budget per contract; the count is journal-derived, so it survives crashes and re-reconciles. */
  maxHeals: number;
}

export function buildArm(config: RunConfig): Arm {
  if (config.defaultArm === "claude") return new ClaudeArm();
  // "codex" is built in like "claude": native stream parsing and tier→model map.
  // An optional [[arms]] name="codex" block only overrides the tier models.
  if (config.defaultArm === "codex") return new CodexArm(codexOptions(config.arms));
  const armConfig = config.arms.find((a) => a.harness === config.defaultArm);
  if (!armConfig) throw new Error(`arm '${config.defaultArm}' not defined in kraken.toml [[arms]]`);
  return new SubprocessArm(armConfig);
}

/** Per-tier ["--model", "x"] / ["-m", "x"] args from an [[arms]] codex block become tier overrides. */
function codexOptions(arms: SubprocessArmConfig[]): { tiers?: Partial<TierMap> } {
  const cfg = arms.find((a) => a.harness === "codex");
  if (!cfg?.tierArgs) return {};
  const tiers: Partial<TierMap> = {};
  for (const tier of ["fast", "standard", "frontier"] as const) {
    const args = cfg.tierArgs[tier] ?? [];
    const flag = args.findIndex((a) => a === "--model" || a === "-m");
    if (flag >= 0 && args[flag + 1]) tiers[tier] = args[flag + 1]!;
  }
  return Object.keys(tiers).length ? { tiers } : {};
}

const PLANNER_PROMPT = (goal: string) => `You are the planning head of a coding-agent fleet.
Decompose the goal below into 1-8 idempotent task contracts for parallel workers,
each in its own git worktree. Prefer fewer, well-boundaried tasks over many
overlapping ones; tasks whose owned paths overlap WILL collide at merge.

FLEET vs SINGLE CONTEXT: fan out ONLY when tasks own genuinely disjoint paths
and can be verified independently. If the work is tightly coupled — shared
files, deep sequential dependencies, one subsystem, or roughly under 5 files
touched — plan exactly ONE task; a single agent with full context outperforms
a fragmented fleet on coupled work, and fan-out pays context-fragmentation
costs (this is the #1 multi-agent failure mode).

HARD SCOPE RULE: every task executes inside THIS repository only — worktrees
are cut from this repo, and workers cannot reach sibling checkouts, other
repositories, or the network. If the goal spans other repositories, plan ONLY
this repository's slice and state in the brief's constraints which parts
belong to other repos (the human chains runs per repo via follow-ups).

Goal: ${goal}

In ALL prose fields (brief items, objectives, outputFormat, keyRisks): wrap
file paths, commands, flags, branch names and code identifiers in backticks —
the review UI renders them as chips.

Reply with ONLY a JSON object:
{"title": "<4-7 word imperative title>",
 "brief": {"objectives": ["<what must exist when done, one per item>"], "constraints": ["<hard rule to respect>"], "doneWhen": ["<verifiable completion criterion>"]},
 "contracts": [...]}
where each contracts element is:
{"id": "<kebab-slug>", "objective": "<ONE sentence, max 160 chars — what this task delivers>", "outputFormat": "<the detail: exact files, structure, and shape of done. Write for human review: short paragraphs separated by blank lines, and lines starting with - for enumerations. Never one run-on paragraph>", "keyRisks": ["<only when genuinely risky (migrations, concurrency, breaking surface): what could go wrong, one per item — omit or empty otherwise>"],
 "ownsPaths": ["glob", ...], "mustNotTouch": ["glob", ...], "skills": ["<skill-name>", ...],
 "modelTier": "fast"|"standard"|"frontier", "dependsOn": ["<id>", ...], "expectedState": "<checkpoint state>"}`;

/** Plan a run: expensive model decomposes the goal into contracts. Human approves via decide(). */
export async function planRun(journal: Journal, config: RunConfig, goal: string): Promise<string> {
  const runId = randomUUID().slice(0, 8);
  journal.append({ type: "RunStarted", runId, goal, repoPath: config.repo });

  const planner = new ClaudeArm();
  const result = await planner.dispatch({
    contract: plannerContract(runId, goal),
    worktree: config.repo,
    skillBlock: "",
    findingsBlock: "",
    modelTier: "frontier",
    raw: true,
  });
  const { title, brief, contracts } = parsePlan(result.output, runId);
  if (contracts.length === 0) {
    throw new Error(`planner returned no usable tasks — it said: ${distill(result.output, 400)}`);
  }
  const problems = contracts.flatMap((c) =>
    validateContract(c).map((p) => `${c.id}: ${p.field} — ${p.message}`),
  );
  journal.append({ type: "PlanProposed", runId, contracts, ...(title ? { title } : {}), ...(brief ? { brief } : {}) });
  requestDecision(journal, config, {
    runId, decisionId: `plan-${runId}`, contractId: null,
    question: `Approve plan for "${goal}"? ${contracts.length} contracts.`,
    options: ["approve", "reject"],
    context: problems.length ? `Validation warnings:\n${problems.join("\n")}` : "Plan validates clean.",
  });
  return runId;
}

/** A planner crash must leave a journaled corpse, not an eternal 'planning…'. */
export async function planRunSafe(journal: Journal, config: RunConfig, goal: string): Promise<string> {
  try {
    return await planRun(journal, config, goal);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const stamps = journal.read();
    const started = [...stamps].reverse().find((s) => s.event.type === "RunStarted" && (s.event as { goal?: string }).goal === goal);
    if (started) {
      const runId = started.event.runId;
      journal.append({ type: "DecisionRequested", runId, decisionId: `plan-failed-${runId}`, contractId: null, question: `Planning failed: ${msg.slice(0, 300)}. Replan with a fuller goal?`, options: ["acknowledge"], context: msg.slice(0, 1500) });
      journal.append({ type: "RunCompleted", runId, outcome: "aborted" });
    }
    throw err;
  }
}

/**
 * Reconcile a run toward done. Idempotent: reads current state from the
 * journal, dispatches what is dispatchable (in dependency waves, so later
 * arms receive earlier arms' findings), judges checkpoints with tier
 * escalation, consumes human decisions, and merges completed work via the
 * speculative train. Run it again after draining decisions.
 */
export async function executeRun(
  journal: Journal,
  config: RunConfig,
  runId: string,
  worktreeRoot: string,
  onProgress: (msg: string) => void = () => {},
): Promise<void> {
  const run = projectRun(journal, runId);
  if (!run) throw new Error(`run ${runId} not found`);
  if (!run.planApproved) throw new Error(`run ${runId} plan not approved — decide on it first`);

  const bus = new FindingsBus(journal);
  const skills = config.skillRoots.flatMap(loadPack);
  const arm = buildArm(config);
  const all = [...run.contracts.values()];
  const contracts = all.map((c) => c.contract);
  const completed: { contractId: string; branch: string }[] = all
    .filter((c) => c.status === "completed" && c.branch)
    .map((c) => ({ contractId: c.contract.id, branch: c.branch! }));

  const dispatchable = new Set(
    all.filter((c) => c.status === "planned" || c.status === "dispatched").map((c) => c.contract.id),
  );
  const settled = new Set(
    all.filter((c) => ["completed", "merged", "parked"].includes(c.status)).map((c) => c.contract.id),
  );

  const runOne = async (contract: TaskContract): Promise<void> => {
    const routed = routeSkills(contract, skills, config.routingRules);
    const view = run.contracts.get(contract.id);
    const repair = [...run.decisions.values()].filter(
      (d) => d.contractId === contract.id && d.resolved && d.choice === "fix-forward",
    ).pop();
    const toolGrant = [...run.decisions.values()].filter(
      (d) => d.contractId === contract.id && d.resolved && d.choice === "retry-with-tools" && d.suggestedTools?.length,
    ).pop();
    const note = steeringNote(run.decisions.values(), contract.id);
    const { worktree, branch } = await createArmWorktree(
      config.repo, contract.id, config.trunk, worktreeRoot, repair !== undefined,
    );
    let tier: ModelTier = contract.modelTier;
    let feedback = repair
      ? [
          "# Repair contract — fix forward, do not start over",
          "Your previous work for this contract is already on this branch. It was ejected from the merge train.",
          view?.ejectReason ? `The merge gates failed with:\n${view.ejectReason}` : "",
          note ? `Reviewer instruction: ${note}` : "",
          "Fix exactly these failures while keeping the completed work intact, then ensure everything builds.",
        ].filter(Boolean).join("\n\n")
      : note
        ? `Reviewer instruction: ${note}`
        : "";

    for (;;) {
      journal.append({
        type: "ContractDispatched", runId, contractId: contract.id,
        armId: `arm-${contract.id}`, harness: arm.harness, modelTier: tier,
        worktree, skillsInjected: routed.skills.map((s) => s.name),
      });
      onProgress(`arm ${contract.id} [${tier}]: dispatched${feedback ? " (with judge feedback)" : ""}`);
      const findings = bus.pendingFor(runId, contract.id, 0).map((p) => p.finding);
      const result = await arm.dispatch(
        {
          contract, worktree,
          skillBlock: renderSkillBlock(routed, skills),
          findingsBlock: [bus.renderFor(findings), feedback].filter(Boolean).join("\n\n"),
          modelTier: tier,
          ...(config.allowedTools.length || toolGrant
            ? { allowedTools: [...config.allowedTools, ...(toolGrant?.suggestedTools ?? [])] }
            : {}),
        },
        (activity) => journal.append({ type: "ArmActivity", runId, contractId: contract.id, activity }),
      );
      if (!result.ok) {
        requestDecision(journal, config, {
          runId, decisionId: `fail-${contract.id}`, contractId: contract.id,
          question: `Arm for ${contract.id} failed. Retry, park, or escalate tier?`,
          options: ["retry", "park", "escalate"], context: result.output.slice(-2000),
        });
        onProgress(`arm ${contract.id}: FAILED — decision requested`);
        return;
      }
      const landed = await commitArmWork(worktree, contract.id, contract.objective, config.trunk);
      if (landed === "no-changes") {
        requestDecision(journal, config, {
          runId, decisionId: `empty-${contract.id}`, contractId: contract.id,
          question: `Arm for ${contract.id} reported success but produced no changes. Retry or park?`,
          options: ["retry", "park"], context: result.output.slice(-2000),
        });
        onProgress(`arm ${contract.id}: NO CHANGES — decision requested`);
        return;
      }

      // Judge the final checkpoint: gates first, one rubric call, end-state only.
      // The judge reads the structured report when the arm filed one.
      const report = parseReport(result.output);
      const checkpoint = contract.checkpoints[contract.checkpoints.length - 1]!;
      journal.append({ type: "CheckpointReached", runId, contractId: contract.id, checkpointId: checkpoint.id });
      const judgeTools = [...config.allowedTools, ...(toolGrant?.suggestedTools ?? [])];
      const { gates, verdict } = await judgeCheckpoint({
        arm, contract, checkpoint, worktree, trunk: config.trunk,
        ...(judgeTools.length ? { allowedTools: judgeTools } : {}),
        workerSummary: report ? JSON.stringify(report, null, 1) : result.output,
      });
      for (const g of gates) {
        journal.append({
          type: "GateResult", runId, contractId: contract.id, checkpointId: checkpoint.id,
          gate: g.gate, passed: g.passed, output: g.output.slice(-2000),
        });
      }
      journal.append({
        type: "CheckpointJudged", runId, contractId: contract.id, checkpointId: checkpoint.id,
        score: verdict.score, pass: verdict.pass, rationale: verdict.rationale,
        ...(verdict.mustFix.length ? { mustFix: verdict.mustFix } : {}),
      });
      onProgress(`judge ${contract.id}: ${verdict.pass ? "PASS" : "FAIL"} (${verdict.score.toFixed(2)}) — ${verdict.rationale.slice(0, 120)}`);

      if (verdict.pass) {
        if (report) {
          const paths = [...new Set([...report.filesTouched, ...contract.boundaries.ownsPaths])];
          const publishAll = (kind: "decision" | "gotcha" | "interface-change" | "blocker", items: string[]) => {
            for (const item of items.slice(0, 6)) {
              bus.publish({ runId, contractId: contract.id, kind, summary: distill(item, 400), paths }, contracts);
            }
          };
          publishAll("decision", report.decisions);
          publishAll("gotcha", report.gotchas);
          publishAll("interface-change", report.interfaceChanges);
          publishAll("blocker", report.blockers);
        } else {
          bus.publish(
            { runId, contractId: contract.id, kind: "decision", summary: distill(result.output, 1500), paths: contract.boundaries.ownsPaths },
            contracts,
          );
        }
        journal.append({
          type: "ContractCompleted", runId, contractId: contract.id, branch,
          summary: report ? distill(report.summary, 800) : distill(result.output, 1500),
          ...(result.costUsd !== undefined ? { costUsd: result.costUsd } : {}),
          ...(report ? { report } : {}),
        });
        completed.push({ contractId: contract.id, branch });
        settled.add(contract.id);
        onProgress(`arm ${contract.id}: completed on ${branch}`);
        return;
      }

      const permGrants = suggestToolGrants(verdict.rationale, verdict.mustFix.join("\n"), report?.blockers.join("\n"));
      if (permGrants.length) {
        requestDecision(journal, config, {
          runId, decisionId: `judge-${contract.id}`, contractId: contract.id,
          question: `${contract.id} is blocked on missing tool permissions (judge ${verdict.score.toFixed(2)}) — a smarter model cannot fix access. Grant and retry, or park?`,
          options: ["retry-with-tools", "retry", "park"],
          context: verdict.rationale,
          suggestedTools: permGrants,
        });
        onProgress(`arm ${contract.id}: permission-blocked — decision requested (no escalation)`);
        return;
      }

      const escalated = nextTier(tier);
      if (escalated) {
        journal.append({ type: "TierEscalated", runId, contractId: contract.id, from: tier, to: escalated, reason: verdict.rationale.slice(0, 500) });
        onProgress(`arm ${contract.id}: escalating ${tier} → ${escalated}`);
        tier = escalated;
        feedback = [
          ...(note ? [`Reviewer instruction: ${note}`] : []),
          "# Judge feedback on your previous attempt (fix these, keep what was right)",
          `Score ${verdict.score.toFixed(2)}: ${verdict.rationale}`,
          ...(verdict.mustFix.length ? ["Required fixes:", ...verdict.mustFix.map((f) => `- ${f}`)] : []),
        ].join("\n");
        continue;
      }
      const grants = suggestToolGrants(verdict.rationale, verdict.mustFix.join("\n"), report?.blockers.join("\n"));
      requestDecision(journal, config, {
        runId, decisionId: `judge-${contract.id}`, contractId: contract.id,
        question: `${contract.id} failed the judge at every tier (last score ${verdict.score.toFixed(2)}). Retry or park?`,
        options: ["retry", ...(grants.length ? ["retry-with-tools"] : []), "park"],
        context: verdict.rationale,
        ...(grants.length ? { suggestedTools: grants } : {}),
      });
      onProgress(`arm ${contract.id}: ladder exhausted — decision requested`);
      return;
    }
  };

  // Gate sanity: if trunk itself is red, cars must not take the blame.
  let trunkGreen = true;
  if (config.gates.length > 0) {
    const probe = await createArmWorktree(config.repo, `gate-probe-${runId}`, config.trunk, worktreeRoot);
    const probeResults = await runCheckpointGates(probe.worktree, config.gates.map((g) => g.command));
    await removeArmWorktree(config.repo, probe.worktree);
    const red = probeResults.filter((g) => !g.passed);
    if (red.length > 0) {
      trunkGreen = false;
      requestDecision(journal, config, {
        runId, decisionId: `trunk-red-${runId}`, contractId: null,
        question: `Trunk itself fails the merge gates (before any fleet work). Fix trunk, then exec again — completed work is held, not blamed.`,
        options: ["acknowledge"],
        context: red.map((g) => `${g.gate}: ${distillGateFailure(g.output)}`).join("\n"),
      });
      onProgress(`trunk is RED under its own gates — holding all merges`);
    }
  }

  // Stale decisions lie. Re-validate the queue against reality before asking
  // a human anything: trunk-red resolves once trunk is green; contract-scoped
  // decisions resolve once that contract merged.
  for (const d of run.decisions.values()) {
    if (d.resolved) continue;
    if (d.decisionId.startsWith("trunk-red-") && trunkGreen) {
      journal.append({ type: "DecisionMade", runId, decisionId: d.decisionId, choice: "auto-resolved", annotation: "trunk passes the gates now", decidedBy: "kraken" });
      onProgress(`decision ${d.decisionId}: auto-resolved — trunk is green`);
    } else if (d.contractId && run.contracts.get(d.contractId)?.status === "merged") {
      journal.append({ type: "DecisionMade", runId, decisionId: d.decisionId, choice: "auto-resolved", annotation: "contract already merged", decidedBy: "kraken" });
      onProgress(`decision ${d.decisionId}: auto-resolved — ${d.contractId} merged`);
    }
  }

  // Dependency waves, each followed by its own train: dependents branch from
  // a trunk that already contains their dependencies' merged code.
  let healed = false;
  const mergeWave = async (): Promise<void> => {
    const alreadyMerged = new Set(
      [...projectRun(journal, runId)!.contracts.values()].filter((c) => c.status === "merged").map((c) => c.contract.id),
    );
    const cars = completed.filter((c) => !alreadyMerged.has(c.contractId));
    if (cars.length === 0 || !trunkGreen) return;
    for (const car of cars) {
      journal.append({ type: "MergeCarQueued", runId, contractId: car.contractId, branch: car.branch });
    }
    const lock = await acquireRepoLock(config.repo);
    const trainResult = await runTrain(cars, {
      repo: config.repo, trunk: config.trunk, gates: config.gates, onProgress,
    });
    lock.release();
    for (const outcome of trainResult.outcomes) {
      if (outcome.status === "merged") {
        journal.append({ type: "MergeCarMerged", runId, contractId: outcome.contractId, commit: outcome.commit });
        completed.splice(completed.findIndex((c) => c.contractId === outcome.contractId), 1);
      } else {
        completed.splice(completed.findIndex((c) => c.contractId === outcome.contractId), 1);
        const detail = distillGateFailure(outcome.detail);
        const reason = `${outcome.reason}: ${detail}`;
        // Evaluate BEFORE journaling this ejection, so the stall comparison sees
        // the previous failure, not the one that just happened.
        const verdict = evaluateHeal(journal, runId, outcome.contractId, reason, config);
        journal.append({ type: "MergeCarEjected", runId, contractId: outcome.contractId, reason });
        const question = verdict.stalled
          ? `${outcome.contractId} ejected from the train (${outcome.reason}) — auto-heal stalled after ${verdict.priorAttempts} attempt${verdict.priorAttempts === 1 ? "" : "s"} (same failure twice): ${detail.slice(0, 160)}. Fix forward on its branch, restart rebased, or park?`
          : `${outcome.contractId} ejected from the train (${outcome.reason}). Fix forward on its branch, restart rebased, or park?`;
        if (verdict.heal) {
          // Tier two of the ladder: mechanical ejections self-heal. The
          // DecisionRequested still lands so the audit trail shows what WOULD
          // have been asked — but no push goes out, and kraken answers itself
          // through the untouched fix-forward repair machinery (branch reuse,
          // gate errors in feedback).
          journal.append({
            type: "DecisionRequested", runId, decisionId: `eject-${outcome.contractId}`, contractId: outcome.contractId,
            question, options: ["fix-forward", "retry-rebased", "park"], context: detail,
          });
          journal.append({
            type: "DecisionMade", runId, decisionId: `eject-${outcome.contractId}`, choice: "fix-forward",
            decidedBy: "kraken", annotation: `auto-heal ${verdict.attempt}/${config.maxHeals}: ${detail.slice(0, 120)}`,
          });
          healed = true;
          onProgress(`${outcome.contractId}: auto-heal ${verdict.attempt}/${config.maxHeals} — fix-forward (mechanical failure, no human needed)`);
        } else {
          requestDecision(journal, config, {
            runId, decisionId: `eject-${outcome.contractId}`, contractId: outcome.contractId,
            question, options: ["fix-forward", "retry-rebased", "park"], context: detail,
          });
        }
      }
    }
  };

  const remaining = new Map(
    contracts.filter((c) => dispatchable.has(c.id)).map((c) => [c.id, c]),
  );
  while (remaining.size > 0) {
    const wave = [...remaining.values()].filter((c) =>
      c.dependsOn.every((dep) => settled.has(dep) || !run.contracts.has(dep)),
    );
    if (wave.length === 0) {
      const blocked = [...remaining.keys()].join(", ");
      onProgress(`blocked (unsettled dependencies): ${blocked}`);
      break;
    }
    for (const c of wave) remaining.delete(c.id);
    onProgress(`wave: ${wave.map((c) => c.id).join(", ")}`);
    const queue = [...wave];
    const inFlight = new Set<Promise<void>>();
    while (queue.length > 0 || inFlight.size > 0) {
      while (queue.length > 0 && inFlight.size < config.maxParallel) {
        const contract = queue.shift()!;
        const p = runOne(contract).finally(() => inFlight.delete(p));
        inFlight.add(p);
      }
      if (inFlight.size > 0) await Promise.race(inFlight);
    }
    // Merge this wave before the next dispatches, so dependents see real code,
    // not just findings — and the judge can verify integration in-worktree.
    await mergeWave();
  }
  await mergeWave();

  if (healed) {
    // Self-healed contracts are planned again — reconcile once more in this
    // invocation so the repair dispatches without human action. Terminates:
    // max_heals caps each contract's budget and stall detection stops repeats.
    onProgress(`auto-heal engaged — reconciling run ${runId} again`);
    return executeRun(journal, config, runId, worktreeRoot, onProgress);
  }

  const finalState = projectRun(journal, runId)!;
  const open = [...finalState.decisions.values()].some((d) => !d.resolved);
  const unfinished = [...finalState.contracts.values()].some(
    (c) => !["merged", "parked"].includes(c.status),
  );
  if (!open && !unfinished) {
    journal.append({ type: "RunCompleted", runId, outcome: "success" });
    onProgress(`run ${runId}: complete, trunk green`);
  } else if (!open) {
    journal.append({ type: "RunCompleted", runId, outcome: "partial" });
    onProgress(`run ${runId}: partial (parked work remains)`);
  } else {
    onProgress(`run ${runId}: waiting on decisions — drain them, then 'kraken exec ${runId}' again`);
  }
}

/**
 * Stable identity of a mechanical failure: directories, line/column numbers
 * and other digits normalize away so the SAME error at a shifted line still
 * matches, while a genuinely different error does not. Same fingerprint twice
 * in a row = the heal made no progress.
 */
export function healFingerprint(reason: string): string {
  return reason
    .toLowerCase()
    .replace(/(?:[\w.~…-]*\/)+([\w.-]+)/g, "$1") // strip directories, keep the basename
    .replace(/\d+/g, "#") // line/col numbers, counts, durations
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

/**
 * Tier two of the three-tier ladder (deterministic → self-heal → judge):
 * should this ejection self-heal as fix-forward? Everything is derived from
 * the journal — heal count from prior kraken-decided "auto-heal" decisions,
 * stall from the previous MergeCarEjected fingerprint — so it is crash-safe
 * and re-reconcile-safe with no new state. Call BEFORE journaling the new
 * ejection. Judge failures never reach this: behavioral doubt is not healable.
 */
export function evaluateHeal(
  journal: Journal,
  runId: string,
  contractId: string,
  reason: string,
  config: { autoHeal: boolean; maxHeals: number },
): { heal: boolean; attempt: number; priorAttempts: number; stalled: boolean } {
  const events = journal.read({ runId });
  const priorEjects = events.filter(
    (s) => s.event.type === "MergeCarEjected" && s.event.contractId === contractId,
  );
  const heals = events.filter(
    (s) => s.event.type === "DecisionMade" && s.event.decisionId === `eject-${contractId}`
      && s.event.decidedBy === "kraken" && s.event.annotation.startsWith("auto-heal"),
  ).length;
  const prev = priorEjects[priorEjects.length - 1];
  const stalled = prev !== undefined
    && healFingerprint((prev.event as { reason: string }).reason) === healFingerprint(reason);
  return {
    heal: config.autoHeal && heals < config.maxHeals && !stalled,
    attempt: heals + 1,
    priorAttempts: priorEjects.length,
    stalled,
  };
}

/** Choices that re-dispatch a contract — a reviewer note on ANY of them must reach the worker. */
const STEERING_CHOICES = ["retry", "retry-rebased", "retry-with-tools", "escalate", "fix-forward"];

/**
 * The most recent reviewer annotation on a resolved retry-family decision for
 * this contract. Steering notes travel on every re-dispatch, not only
 * fix-forward: a human who typed "do NOT repost the comments" next to a plain
 * retry means it just as much.
 */
export function steeringNote(decisions: Iterable<DecisionView>, contractId: string): string | undefined {
  const noted = [...decisions].filter(
    (d) => d.contractId === contractId && d.resolved && !!d.choice && STEERING_CHOICES.includes(d.choice)
      && !!d.annotation?.trim()
      // Machine auto-resolutions (auto-heal) are not reviewer instructions — and
      // must not shadow an earlier human note that still applies.
      && d.decidedBy !== "kraken",
  );
  return noted.pop()?.annotation;
}

/** Derive narrow --allowedTools patterns from permission-flavored failure text: backticked commands become Bash(prefix:*) grants. */
export function suggestToolGrants(...texts: (string | undefined)[]): string[] {
  const joined = texts.filter(Boolean).join("\n");
  if (!/permission|approval|not granted|blocked|denied|non-interactive/i.test(joined)) return [];
  const grants = new Set<string>();
  for (const m of joined.matchAll(/\b(gh|terraform|dotnet|pnpm|npm|cargo|kubectl|helm|gcloud|aws|az|docker|git) ([a-z][\w-]*)\b/g)) {
    grants.add(`Bash(${m[1]} ${m[2]}:*)`);
    if (grants.size >= 6) break;
  }
  for (const m of joined.matchAll(/`([a-z][\w.-]*(?: [\w./{}-]+){0,2})[^`]*`/g)) {
    const words = m[1]!.trim().split(/\s+/);
    if (["the", "a", "kraken", "docs", "src"].includes(words[0]!)) continue;
    if (!/^[a-z][\w.-]*$/.test(words[0]!)) continue;
    grants.add(`Bash(${words.slice(0, 2).join(" ")}:*)`);
    if (grants.size >= 8) break;
  }
  return [...grants].slice(0, 8);
}

function requestDecision(
  journal: Journal,
  config: RunConfig,
  d: { runId: string; decisionId: string; contractId: string | null; question: string; options: string[]; context: string; suggestedTools?: string[] },
): void {
  journal.append({ type: "DecisionRequested", ...d });
  if (config.notifyUrl) void notify(config.notifyUrl, d.question, d.options);
}

function plannerContract(runId: string, goal: string): TaskContract {
  return {
    id: `plan-${runId}`, runId,
    objective: PLANNER_PROMPT(goal),
    outputFormat: "JSON array of task contracts",
    boundaries: { ownsPaths: ["<planning>"], mustNotTouch: [] },
    skills: [], budget: { maxTokens: 50_000, maxToolCalls: 30 },
    modelTier: "frontier",
    checkpoints: [{ id: "plan", expectedState: "valid JSON plan", gates: [] }],
    dependsOn: [],
  };
}

function parsePlan(output: string, runId: string): { title?: string; brief?: RunBrief; contracts: TaskContract[] } {
  for (let from = 0; from >= 0 && from < output.length; ) {
    const objStart = output.indexOf("{", from);
    if (objStart < 0) break;
    const end = balancedEnd(output, objStart);
    if (end < 0) { from = objStart + 1; continue; }
    try {
      const raw = JSON.parse(output.slice(objStart, end + 1)) as { title?: unknown; brief?: unknown; contracts?: unknown };
      if (Array.isArray(raw.contracts)) {
        const b = raw.brief as Record<string, unknown> | undefined;
        const arr = (v: unknown) => (Array.isArray(v) ? v.map(String).filter(Boolean) : []);
        const brief: RunBrief | undefined = b
          ? { objectives: arr(b.objectives), constraints: arr(b.constraints), doneWhen: arr(b.doneWhen) }
          : undefined;
        const contracts = hydrateContracts(raw.contracts as Record<string, unknown>[], runId);
        if (contracts.length > 0) {
          return {
            ...(typeof raw.title === "string" ? { title: raw.title.slice(0, 80) } : {}),
            ...(brief ? { brief } : {}),
            contracts,
          };
        }
      }
    } catch { /* not the object we want; keep scanning */ }
    from = objStart + 1;
  }
  return { contracts: parseContracts(output, runId) };
}

/** Index of the brace closing the object that opens at `start`; -1 if unbalanced. */
function balancedEnd(text: string, start: number): number {
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (esc) { esc = false; continue; }
    if (ch === "\\") { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === "{" || ch === "[") depth++;
    if (ch === "}" || ch === "]") depth--;
    if (depth === 0) return i;
  }
  return -1;
}

function parseContracts(output: string, runId: string): TaskContract[] {
  const json = extractJsonArray(output);
  if (!json) throw new Error(`planner returned no JSON array:\n${output.slice(0, 500)}`);
  const raw = JSON.parse(json) as Record<string, unknown>[];
  return hydrateContracts(raw, runId);
}

function hydrateContracts(raw: Record<string, unknown>[], runId: string): TaskContract[] {
  return raw
    .filter((r) => typeof r.id === "string" && r.id.length > 0 && typeof r.objective === "string" && (r.objective as string).length > 5)
    .map((r) => ({
      ...(Array.isArray(r.keyRisks) && r.keyRisks.length ? { keyRisks: (r.keyRisks as unknown[]).map(String).slice(0, 5) } : {}),
    id: String(r.id),
    runId,
    objective: String(r.objective ?? ""),
    outputFormat: String(r.outputFormat ?? "committed changes + summary"),
    boundaries: {
      ownsPaths: (r.ownsPaths as string[]) ?? [],
      mustNotTouch: (r.mustNotTouch as string[]) ?? [],
    },
    skills: (r.skills as string[]) ?? [],
    budget: { maxTokens: 150_000, maxToolCalls: 100 },
    modelTier: (r.modelTier as TaskContract["modelTier"]) ?? "standard",
    checkpoints: [
      { id: "done", expectedState: String(r.expectedState ?? "task complete, tests green"), gates: [] },
    ],
    dependsOn: (r.dependsOn as string[]) ?? [],
  }));
}

/** Find the first balanced top-level JSON array — models wrap JSON in fences and prose. */
function extractJsonArray(output: string): string | null {
  const start = output.indexOf("[");
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
    if (ch === "[" || ch === "{") depth++;
    if (ch === "]" || ch === "}") depth--;
    if (depth === 0) return output.slice(start, i + 1);
  }
  return null;
}

/** Order contracts into dependency waves (exported for tests). */
export function planWaves(contracts: TaskContract[], settled: Set<string>): TaskContract[][] {
  const remaining = new Map(contracts.map((c) => [c.id, c]));
  const done = new Set(settled);
  const waves: TaskContract[][] = [];
  while (remaining.size > 0) {
    const wave = [...remaining.values()].filter((c) =>
      c.dependsOn.every((dep) => done.has(dep) || !remaining.has(dep) && !contracts.some((x) => x.id === dep)),
    );
    if (wave.length === 0) break;
    for (const c of wave) {
      remaining.delete(c.id);
      done.add(c.id);
    }
    waves.push(wave);
  }
  return waves;
}

/** Store meaning, not noise: strip temp paths and report boilerplate, cut at sentence bounds. */
export function distill(text: string, max = 700): string {
  const cleaned = text
    .replace(/\u001b\[[0-9;]*m/g, "")
    .replace(/\/(?:private\/)?(?:var|tmp)\/[^\s'"]*\/(kraken-[\w-]+|worktrees)\/?/g, "\u2026/")
    .replace(/^#+\s*/gm, "")
    .replace(/\*\*/g, "")
    .replace(/^(my work is complete[^.]*\.|here'?s my summary\.?|summary:?)\s*/gim, "")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length <= max) return cleaned;
  const cut = cleaned.slice(0, max);
  const stop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("; "));
  return (stop > max * 0.5 ? cut.slice(0, stop + 1) : cut).trim() + " \u2026";
}

/** A gate failure's story is the error lines, never the temp path it ran in. */
export function distillGateFailure(detail: string): string {
  const meaningful = detail
    .split("\n")
    .map((l) => l.replace(/\/[^\s:]*\/(kraken-gate-\w+|kraken-[\w-]+)\//g, "\u2026/").trim())
    .filter((l) => /(error|failed|FAIL|warning [A-Z]+\d+|exception)/i.test(l) && l.length > 8);
  const unique = [...new Set(meaningful)];
  return unique.length > 0 ? distill(unique.slice(0, 4).join(" \u00b7 "), 500) : distill(detail, 400);
}

/** Parse the arm's structured report; null means free-text fallback. */
export function parseReport(output: string): WorkerReport | null {
  const anchor = output.lastIndexOf('{"summary"');
  const source = anchor >= 0 ? output.slice(anchor) : output;
  const first = source.indexOf("{");
  if (first < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = first; i < source.length; i++) {
    const ch = source[i];
    if (esc) { esc = false; continue; }
    if (ch === "\\") { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === "{") depth++;
    if (ch === "}") depth--;
    if (depth === 0) {
      try {
        const raw = JSON.parse(source.slice(first, i + 1)) as Record<string, unknown>;
        if (typeof raw.summary !== "string") return null;
        const arr = (v: unknown) => (Array.isArray(v) ? v.map(String).filter(Boolean) : []);
        return {
          summary: raw.summary,
          filesTouched: arr(raw.filesTouched),
          decisions: arr(raw.decisions),
          gotchas: arr(raw.gotchas),
          interfaceChanges: arr(raw.interfaceChanges),
          blockers: arr(raw.blockers),
          confidence: Math.min(1, Math.max(0, Number(raw.confidence) || 0)),
        };
      } catch {
        return null;
      }
    }
  }
  return null;
}

/* ----------------------------------------------------------------------------
 * Campaigns: ONE intent, N single-repo runs chained in dependency order.
 * Every child run keeps ALL single-repo invariants (own worktrees, gates,
 * trunk, train); context crosses repos ONLY through the journal — upstream
 * runs' structured reports are composed into downstream goals. Arms never
 * touch sibling repos.
 * ------------------------------------------------------------------------- */

export interface CampaignSliceSpec {
  repo: string;
  goal: string;
  dependsOn: string[];
}

const CAMPAIGN_PLANNER_PROMPT = (intent: string, repos: string[]) => `You are the campaign planner for a multi-repository coding-agent fleet.
A campaign realizes ONE intent as a chain of single-repository runs; each run's
own planner later decomposes its slice into parallel tasks, and each run merges
into its own trunk behind its own gates. Your job here is only to split the
intent into per-repository slices and order them by dependency.

You may READ any of the repositories listed below (absolute paths) to
understand their structure and interfaces, but change nothing.

Intent: ${intent}

Repositories:
${repos.map((r) => `- ${r}`).join("\n")}

Reply with ONLY a JSON object:
{"title": "<4-7 word campaign title>",
 "slices": [{"repo": "<one of the given absolute paths>",
   "goal": "<complete self-contained goal for that repository's planner: intent, constraints, what done looks like — scoped ENTIRELY to that single repository. Write for human review: short paragraphs separated by blank lines, dash-prefixed bullet lines for enumerations — never one run-on paragraph>",
   "dependsOn": ["<repo path whose slice must land first>", ...]}]}
Rules: at most one slice per repository; slices must form a DAG over the given
repositories (no cycles); omit repositories that need no work; every dependsOn
entry must be the repo path of another slice. A downstream slice's goal should
name what it consumes from upstream as interfaces/contracts, not implementation
details — the concrete interface changes from upstream runs are injected into
its goal automatically when it plans. When a repository's slice is tightly
coupled work (shared files, one subsystem, roughly under 5 files touched), say
so in that slice's goal — its planner should then plan exactly ONE full-context
task instead of fanning out; fan-out pays context-fragmentation costs.`;

/**
 * Plan a campaign: one plan-mode arm reads the repos and splits the intent
 * into a DAG of single-repo slices. CampaignStarted is journaled only after
 * the plan parses and validates — a bad plan throws and leaves no corpse.
 * Returns the campaign key ("campaign:<8-hex-id>").
 */
export async function planCampaign(journal: Journal, intent: string, repos: string[], cwd: string): Promise<string> {
  if (repos.length === 0) throw new Error("a campaign needs at least one repository (--repos /a,/b)");
  const id = randomUUID().slice(0, 8);
  const campaignKey = `campaign:${id}`;
  journal.append({ type: "CampaignPlanning", runId: campaignKey, intent, repos });
  try {
    const planner = new ClaudeArm({ permissionMode: "plan", timeoutMs: 10 * 60 * 1000 });
    const result = await planner.dispatch({
      contract: {
        id: `campaign-plan-${id}`, runId: campaignKey,
        objective: CAMPAIGN_PLANNER_PROMPT(intent, repos),
        outputFormat: "JSON campaign plan",
        boundaries: { ownsPaths: ["<campaign-planning>"], mustNotTouch: [] },
        skills: [], budget: { maxTokens: 60_000, maxToolCalls: 40 },
        modelTier: "standard",
        checkpoints: [{ id: "plan", expectedState: "valid JSON campaign plan", gates: [] }],
        dependsOn: [],
      },
      worktree: repos[0] ?? cwd,
      skillBlock: "", findingsBlock: "", modelTier: "standard", raw: true,
    });
    if (!result.ok) throw new Error(`campaign planner failed: ${distill(result.output, 400)}`);
    const parsed = parseCampaignPlan(result.output);
    if (!parsed) throw new Error(`campaign planner returned no usable JSON — it said: ${distill(result.output, 400)}`);
    const problem = validateCampaignSlices(parsed.slices, repos);
    if (problem) throw new Error(`campaign plan invalid (${problem}) — the model said: ${distill(result.output, 400)}`);
    journal.append({ type: "CampaignStarted", runId: campaignKey, intent, title: parsed.title, slices: parsed.slices });
  } catch (err) {
    journal.append({ type: "CampaignCompleted", runId: campaignKey, outcome: "aborted" });
    throw err;
  }
  return campaignKey;
}

/** Balanced-brace scan for the campaign plan JSON — same discipline as parsePlan. */
function parseCampaignPlan(output: string): { title: string; slices: CampaignSliceSpec[] } | null {
  for (let from = 0; from >= 0 && from < output.length; ) {
    const objStart = output.indexOf("{", from);
    if (objStart < 0) break;
    const end = balancedEnd(output, objStart);
    if (end < 0) { from = objStart + 1; continue; }
    try {
      const raw = JSON.parse(output.slice(objStart, end + 1)) as { title?: unknown; slices?: unknown };
      if (Array.isArray(raw.slices)) {
        const slices = (raw.slices as Record<string, unknown>[])
          .filter((s) => typeof s.repo === "string" && typeof s.goal === "string" && (s.goal as string).length > 5)
          .map((s) => ({
            repo: String(s.repo),
            goal: String(s.goal),
            dependsOn: Array.isArray(s.dependsOn) ? (s.dependsOn as unknown[]).map(String).filter(Boolean) : [],
          }));
        if (slices.length > 0) {
          return { title: typeof raw.title === "string" && raw.title ? raw.title.slice(0, 80) : "Campaign", slices };
        }
      }
    } catch { /* not the object we want; keep scanning */ }
    from = objStart + 1;
  }
  return null;
}

/** Structural validation: every repo known, one slice per repo, deps resolve, no cycles. Returns the problem or null. */
export function validateCampaignSlices(slices: CampaignSliceSpec[], repos: string[]): string | null {
  if (slices.length === 0) return "no slices";
  const known = new Set(repos);
  const sliceRepos = new Set<string>();
  for (const s of slices) {
    if (!known.has(s.repo)) return `slice repo ${s.repo} is not among the given repositories`;
    if (sliceRepos.has(s.repo)) return `duplicate slice for ${s.repo}`;
    sliceRepos.add(s.repo);
  }
  for (const s of slices) {
    for (const d of s.dependsOn) {
      if (d === s.repo) return `${s.repo} depends on itself`;
      if (!sliceRepos.has(d)) return `${s.repo} depends on ${d}, which has no slice`;
    }
  }
  // Peel dependency waves; anything left over sits on a cycle.
  const remaining = new Map(slices.map((s) => [s.repo, s]));
  const done = new Set<string>();
  for (;;) {
    const wave = [...remaining.values()].filter((s) => s.dependsOn.every((d) => done.has(d)));
    if (wave.length === 0) break;
    for (const s of wave) { remaining.delete(s.repo); done.add(s.repo); }
  }
  if (remaining.size > 0) return `dependency cycle among: ${[...remaining.keys()].join(", ")}`;
  return null;
}

/** Slices in topological order (dependencies first). Assumes a validated DAG. */
export function campaignTopoOrder<S extends { repo: string; dependsOn: string[] }>(slices: S[]): S[] {
  const remaining = new Map(slices.map((s) => [s.repo, s]));
  const done = new Set<string>();
  const ordered: S[] = [];
  while (remaining.size > 0) {
    const wave = [...remaining.values()].filter((s) => s.dependsOn.every((d) => done.has(d) || !remaining.has(d)));
    if (wave.length === 0) break; // defensive: validated plans never get here
    for (const s of wave) { remaining.delete(s.repo); done.add(s.repo); ordered.push(s); }
  }
  return [...ordered, ...remaining.values()];
}

const succeeded = (s: CampaignSliceView): boolean =>
  s.childOutcome === "success" || s.childOutcome === "partial";

/**
 * Compose a downstream slice's goal: its own goal plus the journal-carried
 * payload from each dependency's child run — title, outcome, per-task
 * one-liners, and ALL interfaceChanges + decisions from structured reports.
 * This is the ONLY channel through which context crosses repositories.
 */
export function composeSliceGoal(journal: Journal, campaign: CampaignView, slice: CampaignSliceView): string {
  const sections: string[] = [];
  for (const depRepo of slice.dependsOn) {
    const dep = campaign.slices.find((s) => s.repo === depRepo);
    if (!dep?.childRunId) continue;
    const run = projectRun(journal, dep.childRunId);
    if (!run) continue;
    const lines: string[] = [
      `### ${depRepo.split("/").pop() ?? depRepo} — ${run.title ? `"${run.title}"` : `run ${run.runId}`} (${run.outcome ?? "open"})`,
    ];
    const interfaceChanges: string[] = [];
    const decisions: string[] = [];
    for (const c of run.contracts.values()) {
      lines.push(`- ${c.contract.id}: ${c.status}${c.report?.summary ? ` — ${distill(c.report.summary, 200)}` : ""}`);
      if (c.report) {
        interfaceChanges.push(...c.report.interfaceChanges);
        decisions.push(...c.report.decisions);
      }
    }
    if (interfaceChanges.length > 0) {
      lines.push("", "Interface changes to build against:", ...interfaceChanges.map((x) => `- ${x}`));
    }
    if (decisions.length > 0) {
      lines.push("", "Decisions made upstream:", ...decisions.map((x) => `- ${x}`));
    }
    if (dep.childOutcome === "partial") {
      lines.push("", "Note: this upstream run finished PARTIAL — some of its work is parked. Verify what you depend on actually landed before building against it.");
    }
    sections.push(lines.join("\n"));
  }
  return [
    slice.goal,
    ...(sections.length > 0 ? [`## Context from upstream campaign runs\n\n${sections.join("\n\n")}`] : []),
    `(Part of campaign: ${campaign.intent.slice(0, 300)})`,
  ].join("\n\n");
}

/**
 * Re-entrant reconcile over the campaign DAG. For each slice in topological
 * order: plan a child run once its dependencies have succeeded (composing
 * upstream reports into its goal), reconcile approved children via executeRun,
 * and stop where human plan review is pending. Journals CampaignCompleted when
 * every slice's child run has settled. Returns a status summary.
 */
export async function advanceCampaign(
  journal: Journal,
  campaignKey: string,
  worktreeRoot: string,
  onProgress: (msg: string) => void = () => {},
): Promise<string> {
  const campaign = projectCampaign(journal, campaignKey);
  if (!campaign) throw new Error(`campaign ${campaignKey} not found`);
  if (campaign.outcome) return `campaign ${campaign.id}: already finished (${campaign.outcome})`;

  const awaitingReview: string[] = [];
  const blocked: string[] = [];
  const short = (repo: string) => repo.split("/").pop() ?? repo;

  for (const ordered of campaignTopoOrder(campaign.slices)) {
    // Re-project each step: earlier iterations may have executed runs to completion.
    const fresh = projectCampaign(journal, campaignKey)!;
    const slice = fresh.slices.find((s) => s.repo === ordered.repo)!;
    const name = short(slice.repo);

    if (!slice.childRunId) {
      const unmet = slice.dependsOn.filter((d) => !succeeded(fresh.slices.find((s) => s.repo === d)!));
      if (unmet.length > 0) {
        blocked.push(`${name}: waiting on ${unmet.map(short).join(", ")}`);
        continue;
      }
      const goal = composeSliceGoal(journal, fresh, slice);
      onProgress(`campaign ${fresh.id}: planning the ${name} slice (frontier planner, ~1-2 min)…`);
      const childRunId = await planRunSafe(journal, loadConfig(slice.repo), goal);
      journal.append({ type: "CampaignRunLinked", runId: campaignKey, repo: slice.repo, childRunId });
      onProgress(`campaign ${fresh.id}: run ${childRunId} planned for ${name} — awaiting plan review`);
      awaitingReview.push(`${name} → run ${childRunId}`);
      continue;
    }

    const run = projectRun(journal, slice.childRunId);
    if (!run) { blocked.push(`${name}: run ${slice.childRunId} still planning`); continue; }
    if (run.outcome === "success" || run.outcome === "partial") continue; // satisfied — dependents may proceed
    if (run.outcome) { blocked.push(`${name}: run ${slice.childRunId} ended ${run.outcome} — campaign cannot pass it`); continue; }
    if (!run.planApproved) {
      if (run.contracts.size === 0) blocked.push(`${name}: run ${slice.childRunId} still planning`);
      else awaitingReview.push(`${name} → run ${slice.childRunId}`);
      continue;
    }
    // Approved and unfinished: reconcile it. All single-repo invariants
    // (worktrees, gates, judge, merge train) live inside executeRun untouched.
    onProgress(`campaign ${fresh.id}: reconciling run ${slice.childRunId} in ${name}`);
    await executeRun(journal, loadConfig(slice.repo), slice.childRunId, worktreeRoot, onProgress);
    const after = projectRun(journal, slice.childRunId);
    if (!(after?.outcome === "success" || after?.outcome === "partial")) {
      blocked.push(`${name}: run ${slice.childRunId} waiting on decisions — resolve them, then advance again`);
    }
  }

  const final = projectCampaign(journal, campaignKey)!;
  const doneCount = final.slices.filter(succeeded).length;
  if (final.slices.every((s) => s.childOutcome === "success")) {
    journal.append({ type: "CampaignCompleted", runId: campaignKey, outcome: "success" });
    const msg = `campaign ${final.id}: COMPLETE — all ${final.slices.length} slices succeeded`;
    onProgress(msg);
    return msg;
  }
  // A slice is dead when its own run failed terminally, or when an upstream
  // failure means it can never plan. All-dead-or-settled closes the campaign.
  const bySliceRepo = new Map(final.slices.map((s) => [s.repo, s]));
  const dead = (s: CampaignSliceView, seen = new Set<string>()): boolean => {
    if (seen.has(s.repo)) return false;
    seen.add(s.repo);
    if (s.childOutcome && !succeeded(s)) return true;
    if (s.childRunId) return false;
    return s.dependsOn.some((d) => dead(bySliceRepo.get(d)!, seen));
  };
  if (final.slices.every((s) => s.childOutcome !== undefined || dead(s))) {
    journal.append({ type: "CampaignCompleted", runId: campaignKey, outcome: "partial" });
    const msg = `campaign ${final.id}: partial — ${doneCount}/${final.slices.length} slices landed, the rest declined/parked`;
    onProgress(msg);
    return msg;
  }
  const parts = [
    ...awaitingReview.map((r) => `plan awaiting review: ${r}`),
    ...blocked,
  ];
  return [
    `campaign ${final.id}: ${doneCount}/${final.slices.length} slices done`,
    ...parts.map((p) => `  - ${p}`),
    ...(awaitingReview.length > 0 ? ["approve pending plans on the bridge (approval auto-advances) or via: kraken decide <runId> plan-<runId> approve && kraken campaign-adv " + final.id] : []),
  ].join("\n");
}

/** One merge train per repo at a time: concurrent runs queue at the trunk, SubmitQueue-style. */
async function acquireRepoLock(repo: string): Promise<{ release: () => void }> {
  const { mkdirSync, rmSync, statSync } = await import("node:fs");
  const { join } = await import("node:path");
  const dir = join(repo, ".git", "kraken-train.lock");
  const started = Date.now();
  for (;;) {
    try {
      mkdirSync(dir);
      return { release: () => { try { rmSync(dir, { recursive: true }); } catch { /* already gone */ } } };
    } catch {
      try {
        if (Date.now() - statSync(dir).mtimeMs > 30 * 60 * 1000) { rmSync(dir, { recursive: true }); continue; }
      } catch { continue; }
      if (Date.now() - started > 20 * 60 * 1000) throw new Error("train lock timeout: another run has held the trunk for 20m");
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}
