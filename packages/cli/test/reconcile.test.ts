import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Journal, projectRun } from "@kraken/core";
import type { TaskContract } from "@kraken/core";
import { planWaves, steeringNote } from "../src/run.ts";
import { loadConfig } from "../src/config.ts";

const contract = (id: string, dependsOn: string[] = []): TaskContract => ({
  id,
  runId: "r1",
  objective: `Do the ${id} part of the work properly`,
  outputFormat: "branch",
  boundaries: { ownsPaths: [`${id}/**`], mustNotTouch: [] },
  skills: [],
  budget: { maxTokens: 1000, maxToolCalls: 10 },
  modelTier: "fast",
  checkpoints: [{ id: "done", expectedState: "green", gates: [] }],
  dependsOn,
});

describe("dependency waves", () => {
  it("orders contracts so dependents run after their dependencies", () => {
    const waves = planWaves(
      [contract("a"), contract("b", ["a"]), contract("c", ["a"]), contract("d", ["b", "c"])],
      new Set(),
    );
    expect(waves.map((w) => w.map((c) => c.id).sort())).toEqual([["a"], ["b", "c"], ["d"]]);
  });

  it("treats already-settled and unknown dependencies as satisfied", () => {
    const waves = planWaves([contract("b", ["a", "ghost"])], new Set(["a"]));
    expect(waves).toEqual([[expect.objectContaining({ id: "b" })]]);
  });

  it("stops on circular dependencies instead of spinning", () => {
    const waves = planWaves([contract("a", ["b"]), contract("b", ["a"])], new Set());
    expect(waves).toEqual([]);
  });
});

describe("decision semantics in the projection", () => {
  const journal = () => new Journal(join(mkdtempSync(join(tmpdir(), "kraken-cli-")), "j.db"));

  it("park shelves a contract; retry hands it back to the reconciler", () => {
    const j = journal();
    j.append({ type: "RunStarted", runId: "r1", goal: "g", repoPath: "/r" });
    j.append({ type: "PlanProposed", runId: "r1", contracts: [contract("a"), contract("b")] });
    j.append({ type: "DecisionRequested", runId: "r1", decisionId: "fail-a", contractId: "a", question: "?", options: ["retry", "park"], context: "" });
    j.append({ type: "DecisionRequested", runId: "r1", decisionId: "fail-b", contractId: "b", question: "?", options: ["retry", "park"], context: "" });
    j.append({ type: "DecisionMade", runId: "r1", decisionId: "fail-a", choice: "park", annotation: "", decidedBy: "t" });
    j.append({ type: "DecisionMade", runId: "r1", decisionId: "fail-b", choice: "retry", annotation: "", decidedBy: "t" });
    const run = projectRun(j, "r1")!;
    expect(run.contracts.get("a")!.status).toBe("parked");
    expect(run.contracts.get("b")!.status).toBe("planned");
  });

  it("carries reviewer annotations on every retry-family choice, not only fix-forward", () => {
    const j = journal();
    j.append({ type: "RunStarted", runId: "r1", goal: "g", repoPath: "/r" });
    j.append({ type: "PlanProposed", runId: "r1", contracts: [contract("a")] });
    j.append({ type: "DecisionRequested", runId: "r1", decisionId: "fail-a", contractId: "a", question: "?", options: ["retry", "park"], context: "" });
    j.append({ type: "DecisionMade", runId: "r1", decisionId: "fail-a", choice: "retry", annotation: "the comments are already posted — verify, do not repost", decidedBy: "t" });
    const run = projectRun(j, "r1")!;
    expect(steeringNote(run.decisions.values(), "a")).toBe("the comments are already posted — verify, do not repost");
    expect(steeringNote(run.decisions.values(), "b")).toBeUndefined();
  });

  it("takes the most recent annotated steering decision and ignores park/unannotated ones", () => {
    const j = journal();
    j.append({ type: "RunStarted", runId: "r1", goal: "g", repoPath: "/r" });
    j.append({ type: "PlanProposed", runId: "r1", contracts: [contract("a")] });
    j.append({ type: "DecisionRequested", runId: "r1", decisionId: "eject-a", contractId: "a", question: "?", options: ["fix-forward", "park"], context: "" });
    j.append({ type: "DecisionMade", runId: "r1", decisionId: "eject-a", choice: "fix-forward", annotation: "older instruction", decidedBy: "t" });
    j.append({ type: "DecisionRequested", runId: "r1", decisionId: "judge-a", contractId: "a", question: "?", options: ["retry-with-tools", "park"], context: "" });
    j.append({ type: "DecisionMade", runId: "r1", decisionId: "judge-a", choice: "retry-with-tools", annotation: "newer instruction", decidedBy: "t" });
    j.append({ type: "DecisionRequested", runId: "r1", decisionId: "empty-a", contractId: "a", question: "?", options: ["retry", "park"], context: "" });
    j.append({ type: "DecisionMade", runId: "r1", decisionId: "empty-a", choice: "retry", annotation: "  ", decidedBy: "t" });
    const run = projectRun(j, "r1")!;
    expect(steeringNote(run.decisions.values(), "a")).toBe("newer instruction");
    // Unresolved and non-steering choices never steer.
    j.append({ type: "DecisionRequested", runId: "r1", decisionId: "late-a", contractId: "a", question: "?", options: ["retry", "park"], context: "" });
    j.append({ type: "DecisionMade", runId: "r1", decisionId: "late-a", choice: "park", annotation: "shelve it", decidedBy: "t" });
    expect(steeringNote(projectRun(j, "r1")!.decisions.values(), "a")).toBe("newer instruction");
  });

  it("records tier escalation and judge scores", () => {
    const j = journal();
    j.append({ type: "RunStarted", runId: "r1", goal: "g", repoPath: "/r" });
    j.append({ type: "PlanProposed", runId: "r1", contracts: [contract("a")] });
    j.append({ type: "CheckpointReached", runId: "r1", contractId: "a", checkpointId: "done" });
    j.append({ type: "CheckpointJudged", runId: "r1", contractId: "a", checkpointId: "done", score: 0.4, pass: false, rationale: "missing tests" });
    j.append({ type: "TierEscalated", runId: "r1", contractId: "a", from: "fast", to: "standard", reason: "missing tests" });
    const run = projectRun(j, "r1")!;
    expect(run.contracts.get("a")!.lastJudgeScore).toBe(0.4);
  });
});

describe("config parsing", () => {
  it("parses arms, notify_url, and default_arm from kraken.toml", () => {
    const dir = mkdtempSync(join(tmpdir(), "kraken-cfg-"));
    writeFileSync(join(dir, "kraken.toml"), `
trunk = "develop"
gates = ["pnpm test", "pnpm lint"]
max_parallel = 8
default_arm = "codex"
notify_url = "https://ntfy.sh/my-fleet"
auto_heal = false
max_heals = 5

[[rules]]
skill = "tdd"
always = true

[[arms]]
name = "codex"
command = ["codex", "exec", "--json"]
frontier_args = ["--model", "o4"]
`);
    const cfg = loadConfig(dir);
    expect(cfg.trunk).toBe("develop");
    expect(cfg.gates).toEqual([{ command: "pnpm test" }, { command: "pnpm lint" }]);
    expect(cfg.maxParallel).toBe(8);
    expect(cfg.defaultArm).toBe("codex");
    expect(cfg.notifyUrl).toBe("https://ntfy.sh/my-fleet");
    expect(cfg.autoHeal).toBe(false);
    expect(cfg.maxHeals).toBe(5);
    expect(cfg.routingRules).toEqual([{ skill: "tdd", always: true }]);
    expect(cfg.arms).toEqual([
      { harness: "codex", command: ["codex", "exec", "--json"], tierArgs: { frontier: ["--model", "o4"] } },
    ]);
  });
});
