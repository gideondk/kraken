import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Journal } from "@kraken/core";
import type { TaskContract } from "@kraken/core";
import { FindingsBus } from "../src/index.ts";

const contract = (id: string, ownsPaths: string[], objective = "work on things"): TaskContract => ({
  id,
  runId: "r1",
  objective,
  outputFormat: "branch",
  boundaries: { ownsPaths, mustNotTouch: [] },
  skills: [],
  budget: { maxTokens: 1, maxToolCalls: 1 },
  modelTier: "fast",
  checkpoints: [{ id: "done", expectedState: "green", gates: [] }],
  dependsOn: [],
});

const freshBus = () => {
  const j = new Journal(join(mkdtempSync(join(tmpdir(), "kraken-bus-")), "j.db"));
  j.append({ type: "RunStarted", runId: "r1", goal: "g", repoPath: "/repo" });
  return { j, bus: new FindingsBus(j) };
};

describe("findings bus", () => {
  it("routes by path overlap, not firehose", () => {
    const { bus } = freshBus();
    const siblings = [
      contract("c1", ["services/medication/**"]),
      contract("c2", ["services/alerts/**"]),
      contract("c3", ["web/**"]),
    ];
    const { routedTo } = bus.publish(
      {
        runId: "r1",
        contractId: "c1",
        kind: "interface-change",
        summary: "HoldPlaced events are per-medication, key on medicationId",
        paths: ["services/alerts/consumers/HoldConsumer.cs"],
      },
      siblings,
    );
    expect(routedTo).toEqual(["c2"]); // c3 untouched, publisher excluded
  });

  it("broadcasts blockers to every sibling", () => {
    const { bus } = freshBus();
    const siblings = [contract("c1", ["a/**"]), contract("c2", ["b/**"]), contract("c3", ["c/**"])];
    const { routedTo } = bus.publish(
      { runId: "r1", contractId: "c1", kind: "blocker", summary: "EMARS sandbox is down" },
      siblings,
    );
    expect(routedTo.sort()).toEqual(["c2", "c3"]);
  });

  it("delivers pending findings once, cursor-based, and renders them for injection", () => {
    const { bus } = freshBus();
    const siblings = [contract("c1", ["services/medication/**"]), contract("c2", ["services/medication/api/**"])];
    bus.publish(
      { runId: "r1", contractId: "c1", kind: "gotcha", summary: "freq=2d never expanded, don't assume daily", paths: ["services/medication/api/Schedule.cs"] },
      siblings,
    );
    const pending = bus.pendingFor("r1", "c2", 0);
    expect(pending).toHaveLength(1);
    const rendered = bus.renderFor(pending.map((p) => p.finding));
    expect(rendered).toContain("don't assume daily");
    // Advancing the cursor past the routing event yields nothing new.
    const after = bus.pendingFor("r1", "c2", pending[0]!.seq);
    expect(after).toHaveLength(0);
  });
});
