import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPack, routeSkills, renderSkillBlock, globMatch } from "../src/index.ts";
import type { TaskContract } from "@kraken/core";

function makePack(): string {
  const root = mkdtempSync(join(tmpdir(), "kraken-skills-"));
  const mk = (name: string, desc: string) => {
    const dir = join(root, name);
    mkdirSync(dir);
    writeFileSync(
      join(dir, "SKILL.md"),
      `---\nname: ${name}\ndescription: ${desc}\n---\n\n# ${name}\n\nBody of ${name}.\n`,
    );
  };
  mk("event-sourcing-conventions", "Aggregates, events, projections done right");
  mk("foundation-build", "Strict TDD loop for implementing specs");
  mk("foundation-servicebase", "Service contracts and communication modes");
  mk("foundation-slop", "Comment hygiene and code quality bar");
  mk("foundation-ux", "SPA UX conventions");
  return root;
}

const contract = (over: Partial<TaskContract> = {}): TaskContract => ({
  id: "c1",
  runId: "r1",
  objective: "Add a HoldPlaced event and projection for medication holds",
  outputFormat: "branch + tests",
  boundaries: { ownsPaths: ["services/medication/**"], mustNotTouch: [] },
  skills: [],
  budget: { maxTokens: 100_000, maxToolCalls: 50 },
  modelTier: "standard",
  checkpoints: [{ id: "done", expectedState: "green", gates: [] }],
  dependsOn: [],
  ...over,
});

describe("skill routing", () => {
  const pack = loadPack(makePack());

  it("loads packs with frontmatter names and descriptions", () => {
    expect(pack.map((s) => s.name)).toContain("event-sourcing-conventions");
    expect(pack.find((s) => s.name === "foundation-build")!.description).toMatch(/TDD/);
  });

  it("routes by objective terms and path patterns, capped at 4", () => {
    const routed = routeSkills(contract(), pack, [
      { skill: "event-sourcing-conventions", objectiveTerms: ["event", "projection", "aggregate"] },
      { skill: "foundation-servicebase", pathPatterns: ["services/**"] },
      { skill: "foundation-build", always: true },
      { skill: "foundation-slop", always: true },
      { skill: "foundation-ux", pathPatterns: ["web/**"] },
    ]);
    const names = routed.skills.map((s) => s.name);
    expect(names).toContain("event-sourcing-conventions");
    expect(names).toContain("foundation-servicebase");
    expect(names).toContain("foundation-build");
    expect(names).not.toContain("foundation-ux"); // wrong path
    expect(names.length).toBeLessThanOrEqual(4);
    expect(routed.reasons["event-sourcing-conventions"]).toMatch(/objective mentions/);
  });

  it("contract-requested skills win and missing ones are surfaced, never silent", () => {
    const routed = routeSkills(
      contract({ skills: ["foundation-ux", "does-not-exist"] }),
      pack,
      [],
    );
    expect(routed.skills.map((s) => s.name)).toEqual(["foundation-ux"]);
    expect(routed.missing).toEqual(["does-not-exist"]);
  });

  it("renders injected skills full-content plus a manifest of the rest", () => {
    const routed = routeSkills(contract({ skills: ["foundation-build"] }), pack, []);
    const block = renderSkillBlock(routed, pack);
    expect(block).toContain("Body of foundation-build");
    expect(block).not.toContain("Body of foundation-ux");
    expect(block).toMatch(/- foundation-ux:/); // manifest line only
  });
});

describe("globMatch", () => {
  it("handles ** across directories and * within segments", () => {
    expect(globMatch("services/**", "services/medication/Hold.cs")).toBe(true);
    expect(globMatch("services/*", "services/medication")).toBe(true);
    expect(globMatch("services/*", "services/medication/Hold.cs")).toBe(false);
    expect(globMatch("web/**", "services/medication/Hold.cs")).toBe(false);
  });
});
