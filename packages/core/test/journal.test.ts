import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Journal, projectRun, pendingDecisions, validateContract } from "../src/index.ts";
import type { TaskContract } from "../src/index.ts";

const contract = (id: string, over: Partial<TaskContract> = {}): TaskContract => ({
  id,
  runId: "r1",
  objective: "Implement EMARS delete-awareness for scheduled doses",
  outputFormat: "Branch with passing tests and a summary",
  boundaries: { ownsPaths: ["services/emars/**"], mustNotTouch: ["Foundation/**"] },
  skills: ["event-sourcing-conventions"],
  budget: { maxTokens: 100_000, maxToolCalls: 50 },
  modelTier: "standard",
  checkpoints: [{ id: "done", expectedState: "tests green", gates: ["dotnet test"] }],
  dependsOn: [],
  ...over,
});

const freshJournal = () => new Journal(join(mkdtempSync(join(tmpdir(), "kraken-")), "j.db"));

describe("journal", () => {
  it("appends and replays events in order", () => {
    const j = freshJournal();
    j.append({ type: "RunStarted", runId: "r1", goal: "g", repoPath: "/repo" });
    j.append({ type: "PlanProposed", runId: "r1", contracts: [contract("c1")] });
    const events = j.read({ runId: "r1" });
    expect(events.map((e) => e.event.type)).toEqual(["RunStarted", "PlanProposed"]);
    expect(events[0]!.seq).toBeLessThan(events[1]!.seq);
  });

  it("survives restart — replay from disk gives identical state", () => {
    const dir = mkdtempSync(join(tmpdir(), "kraken-"));
    const path = join(dir, "j.db");
    const j1 = new Journal(path);
    j1.append({ type: "RunStarted", runId: "r1", goal: "g", repoPath: "/repo" });
    j1.append({ type: "PlanProposed", runId: "r1", contracts: [contract("c1")] });
    j1.close();
    const j2 = new Journal(path);
    const run = projectRun(j2, "r1");
    expect(run?.contracts.get("c1")?.status).toBe("planned");
  });

  it("notifies live subscribers", () => {
    const j = freshJournal();
    const seen: string[] = [];
    const unsub = j.subscribe((e) => seen.push(e.event.type));
    j.append({ type: "RunStarted", runId: "r1", goal: "g", repoPath: "/repo" });
    unsub();
    j.append({ type: "RunCompleted", runId: "r1", outcome: "success" });
    expect(seen).toEqual(["RunStarted"]);
  });
});

describe("run projection", () => {
  it("walks a contract through its lifecycle to merged", () => {
    const j = freshJournal();
    j.append({ type: "RunStarted", runId: "r1", goal: "g", repoPath: "/repo" });
    j.append({ type: "PlanProposed", runId: "r1", contracts: [contract("c1")] });
    j.append({ type: "PlanDecision", runId: "r1", decision: "approved", annotations: [] });
    j.append({ type: "ContractDispatched", runId: "r1", contractId: "c1", armId: "arm-1", harness: "claude-code", modelTier: "standard", worktree: "/wt/c1", skillsInjected: ["event-sourcing-conventions"] });
    j.append({ type: "ContractCompleted", runId: "r1", contractId: "c1", branch: "kraken/c1", summary: "done" });
    j.append({ type: "MergeCarQueued", runId: "r1", contractId: "c1", branch: "kraken/c1" });
    j.append({ type: "MergeCarMerged", runId: "r1", contractId: "c1", commit: "abc123" });
    const run = projectRun(j, "r1")!;
    expect(run.planApproved).toBe(true);
    expect(run.contracts.get("c1")?.status).toBe("merged");
  });

  it("routes contracts into awaiting-decision and back on human input", () => {
    const j = freshJournal();
    j.append({ type: "RunStarted", runId: "r1", goal: "g", repoPath: "/repo" });
    j.append({ type: "PlanProposed", runId: "r1", contracts: [contract("c1")] });
    j.append({ type: "ContractDispatched", runId: "r1", contractId: "c1", armId: "a", harness: "claude-code", modelTier: "standard", worktree: "/wt", skillsInjected: [] });
    j.append({ type: "DecisionRequested", runId: "r1", decisionId: "d1", contractId: "c1", question: "Collapse outcome codes?", options: ["yes", "no"], context: "conflicts with foundation-glossary" });
    expect(projectRun(j, "r1")!.contracts.get("c1")!.status).toBe("awaiting-decision");
    expect(pendingDecisions(j)).toHaveLength(1);
    j.append({ type: "DecisionMade", runId: "r1", decisionId: "d1", choice: "no", annotation: "lossy domain mapping", decidedBy: "gideon" });
    expect(projectRun(j, "r1")!.contracts.get("c1")!.status).toBe("dispatched");
    expect(pendingDecisions(j)).toHaveLength(0);
  });
});

describe("contract validation", () => {
  it("accepts a well-formed contract", () => {
    expect(validateContract(contract("c1"))).toEqual([]);
  });
  it("rejects vague objectives and missing boundaries", () => {
    const bad = contract("c1", { objective: "fix it", boundaries: { ownsPaths: [], mustNotTouch: [] } });
    const fields = validateContract(bad).map((p) => p.field);
    expect(fields).toContain("objective");
    expect(fields).toContain("boundaries.ownsPaths");
  });
});
