import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Journal, projectCampaign } from "@kraken/core";
import type { TaskContract } from "@kraken/core";
import { campaignTopoOrder, composeSliceGoal, validateCampaignSlices } from "../src/run.ts";

const journal = () => new Journal(join(mkdtempSync(join(tmpdir(), "kraken-campaign-")), "j.db"));

const contract = (id: string, runId: string): TaskContract => ({
  id,
  runId,
  objective: `Do the ${id} part of the work properly`,
  outputFormat: "branch",
  boundaries: { ownsPaths: [`${id}/**`], mustNotTouch: [] },
  skills: [],
  budget: { maxTokens: 1000, maxToolCalls: 10 },
  modelTier: "fast",
  checkpoints: [{ id: "done", expectedState: "green", gates: [] }],
  dependsOn: [],
});

describe("campaign plan validation", () => {
  it("accepts a DAG over the given repos", () => {
    expect(validateCampaignSlices([
      { repo: "/repos/api", goal: "rename the endpoint", dependsOn: [] },
      { repo: "/repos/web", goal: "consume the new endpoint", dependsOn: ["/repos/api"] },
    ], ["/repos/api", "/repos/web", "/repos/docs"])).toBeNull();
  });

  it("rejects unknown repos, dangling deps, self-deps, and cycles", () => {
    expect(validateCampaignSlices(
      [{ repo: "/repos/ghost", goal: "haunt the codebase", dependsOn: [] }], ["/repos/api"],
    )).toMatch(/not among/);
    expect(validateCampaignSlices(
      [{ repo: "/repos/api", goal: "rename things", dependsOn: ["/repos/web"] }], ["/repos/api", "/repos/web"],
    )).toMatch(/no slice/);
    expect(validateCampaignSlices(
      [{ repo: "/repos/api", goal: "rename things", dependsOn: ["/repos/api"] }], ["/repos/api"],
    )).toMatch(/itself/);
    expect(validateCampaignSlices([
      { repo: "/repos/api", goal: "rename things", dependsOn: ["/repos/web"] },
      { repo: "/repos/web", goal: "consume things", dependsOn: ["/repos/api"] },
    ], ["/repos/api", "/repos/web"])).toMatch(/cycle/);
  });
});

describe("campaign DAG readiness", () => {
  it("derives per-slice childStatus from the linked child run's lifecycle", () => {
    const j = journal();
    const key = "campaign:cafe0001";
    j.append({ type: "CampaignStarted", runId: key, intent: "ship the rename everywhere", title: "Rename rollout", slices: [
      { repo: "/repos/api", goal: "rename in api", dependsOn: [] },
      { repo: "/repos/web", goal: "consume new api", dependsOn: ["/repos/api"] },
    ] });
    expect(projectCampaign(j, key)!.slices.map((s) => s.childStatus)).toEqual(["pending", "pending"]);

    j.append({ type: "RunStarted", runId: "r-api", goal: "rename in api", repoPath: "/repos/api" });
    j.append({ type: "CampaignRunLinked", runId: key, repo: "/repos/api", childRunId: "r-api" });
    expect(projectCampaign(j, key)!.slices[0]!.childStatus).toBe("planning");

    j.append({ type: "PlanProposed", runId: "r-api", contracts: [contract("t1", "r-api")] });
    expect(projectCampaign(j, key)!.slices[0]!.childStatus).toBe("plan review");

    j.append({ type: "PlanDecision", runId: "r-api", decision: "approved", annotations: [] });
    expect(projectCampaign(j, key)!.slices[0]!.childStatus).toBe("running");

    j.append({ type: "RunCompleted", runId: "r-api", outcome: "success" });
    const done = projectCampaign(j, key)!;
    expect(done.slices[0]!.childStatus).toBe("success");
    expect(done.slices[0]!.childOutcome).toBe("success");
    expect(done.slices[1]!.childStatus).toBe("pending");

    // topological order puts dependencies first, whatever the stored order
    const order = campaignTopoOrder([...done.slices].reverse());
    expect(order.map((s) => s.repo)).toEqual(["/repos/api", "/repos/web"]);
  });
});

describe("upstream context composition", () => {
  it("carries upstream interfaceChanges and decisions into the downstream goal via the journal", () => {
    const j = journal();
    const key = "campaign:cafe0002";
    j.append({ type: "CampaignStarted", runId: key, intent: "ship the v2 rename across the stack", title: "V2 rename", slices: [
      { repo: "/repos/api", goal: "rename in api", dependsOn: [] },
      { repo: "/repos/web", goal: "consume new api", dependsOn: ["/repos/api"] },
    ] });
    j.append({ type: "RunStarted", runId: "r-api", goal: "rename in api", repoPath: "/repos/api" });
    j.append({ type: "CampaignRunLinked", runId: key, repo: "/repos/api", childRunId: "r-api" });
    j.append({ type: "PlanProposed", runId: "r-api", contracts: [contract("rename-route", "r-api")], title: "Rename the API route" });
    j.append({ type: "PlanDecision", runId: "r-api", decision: "approved", annotations: [] });
    j.append({
      type: "ContractCompleted", runId: "r-api", contractId: "rename-route", branch: "kraken/rename-route",
      summary: "route renamed",
      report: {
        summary: "Renamed the route and kept a redirect",
        filesTouched: ["src/routes.ts"],
        decisions: ["kept the old route as a 301 redirect for one release"],
        gotchas: [],
        interfaceChanges: ["POST /v2/rename replaces POST /v1/rename; body field `name` is now required"],
        blockers: [],
        confidence: 0.9,
      },
    });
    j.append({ type: "RunCompleted", runId: "r-api", outcome: "success" });

    const c = projectCampaign(j, key)!;
    const goal = composeSliceGoal(j, c, c.slices.find((s) => s.repo === "/repos/web")!);
    expect(goal).toContain("consume new api");
    expect(goal).toContain("## Context from upstream campaign runs");
    expect(goal).toContain("Rename the API route");
    expect(goal).toContain("POST /v2/rename replaces POST /v1/rename");
    expect(goal).toContain("kept the old route as a 301 redirect");
    expect(goal).toContain("(Part of campaign: ship the v2 rename across the stack)");
  });

  it("composes no upstream section for root slices", () => {
    const j = journal();
    const key = "campaign:cafe0003";
    j.append({ type: "CampaignStarted", runId: key, intent: "roll out the thing", title: "Rollout", slices: [
      { repo: "/repos/api", goal: "rename in api", dependsOn: [] },
    ] });
    const c = projectCampaign(j, key)!;
    const goal = composeSliceGoal(j, c, c.slices[0]!);
    expect(goal).not.toContain("## Context from upstream campaign runs");
    expect(goal).toContain("rename in api");
    expect(goal).toContain("(Part of campaign: roll out the thing)");
  });
});
