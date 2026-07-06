import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { radar, runTrain, revParse } from "../src/index.ts";

/** Build a real git repo with a trunk and helper to cut branches. */
function makeRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "kraken-train-"));
  const g = (...args: string[]) =>
    execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" }).toString();
  g("init", "-q", "-b", "main");
  g("config", "user.email", "kraken@test");
  g("config", "user.name", "kraken");
  writeFileSync(join(repo, "schedule.txt"), "daily\n");
  writeFileSync(join(repo, "check.sh"), "#!/bin/sh\ngrep -q daily schedule.txt || grep -q 2d schedule.txt\n");
  execFileSync("chmod", ["+x", join(repo, "check.sh")]);
  g("add", "-A");
  g("commit", "-qm", "init");
  return repo;
}

function branchWithChange(repo: string, name: string, file: string, content: string): void {
  const g = (...args: string[]) =>
    execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" }).toString();
  g("checkout", "-qb", name, "main");
  const full = join(repo, file);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content);
  g("add", "-A");
  g("commit", "-qm", `${name}: change ${file}`);
  g("checkout", "-q", "main");
}

let repo: string;
beforeEach(() => {
  repo = makeRepo();
});

describe("radar", () => {
  it("stays quiet when branches touch different files", async () => {
    branchWithChange(repo, "arm-1", "a.txt", "one\n");
    branchWithChange(repo, "arm-2", "b.txt", "two\n");
    expect(await radar(repo, ["arm-1", "arm-2"])).toEqual([]);
  });

  it("warns when two live branches edit the same lines", async () => {
    branchWithChange(repo, "arm-1", "schedule.txt", "hourly\n");
    branchWithChange(repo, "arm-2", "schedule.txt", "weekly\n");
    const warnings = await radar(repo, ["arm-1", "arm-2"]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.files).toContain("schedule.txt");
  });
});

describe("speculative merge train", () => {
  it("merges clean cars and advances trunk atomically", async () => {
    branchWithChange(repo, "arm-1", "a.txt", "one\n");
    branchWithChange(repo, "arm-2", "b.txt", "two\n");
    const result = await runTrain(
      [
        { contractId: "c1", branch: "arm-1" },
        { contractId: "c2", branch: "arm-2" },
      ],
      { repo, trunk: "main", gates: [] },
    );
    expect(result.outcomes.map((o) => o.status)).toEqual(["merged", "merged"]);
    expect(result.trunkAfter).not.toBe(result.trunkBefore);
    expect(await revParse(repo, "main")).toBe(result.trunkAfter);
  });

  it("ejects the conflicting car alone; the car behind it still merges", async () => {
    branchWithChange(repo, "arm-1", "schedule.txt", "hourly\n");
    branchWithChange(repo, "arm-2", "schedule.txt", "weekly\n");
    branchWithChange(repo, "arm-3", "c.txt", "three\n");
    const result = await runTrain(
      [
        { contractId: "c1", branch: "arm-1" },
        { contractId: "c2", branch: "arm-2" },
        { contractId: "c3", branch: "arm-3" },
      ],
      { repo, trunk: "main", gates: [] },
    );
    const byId = Object.fromEntries(result.outcomes.map((o) => [o.contractId, o]));
    expect(byId.c1!.status).toBe("merged");
    expect(byId.c2!.status).toBe("ejected");
    expect((byId.c2 as { reason: string }).reason).toBe("textual-conflict");
    expect(byId.c3!.status).toBe("merged");
  });

  it("validates against PREDICTED head: a car conflicting only with an earlier car ejects", async () => {
    // arm-1 and arm-2 both edit the same file; each merges cleanly onto main
    // in isolation — the conflict only exists against the predicted state.
    branchWithChange(repo, "arm-1", "schedule.txt", "hourly\n");
    branchWithChange(repo, "arm-2", "schedule.txt", "weekly\n");
    const result = await runTrain(
      [
        { contractId: "c1", branch: "arm-1" },
        { contractId: "c2", branch: "arm-2" },
      ],
      { repo, trunk: "main", gates: [] },
    );
    expect(result.outcomes[0]!.status).toBe("merged");
    expect(result.outcomes[1]!.status).toBe("ejected");
  });

  it("catches semantic conflicts: textual merge passes, gate fails, car ejects", async () => {
    // arm-1 changes the data format; arm-2 adds an unrelated file but the
    // combined state breaks the repo's own check — textually clean, semantically broken.
    branchWithChange(repo, "arm-1", "schedule.txt", "fortnightly\n");
    branchWithChange(repo, "arm-2", "unrelated.txt", "hi\n");
    const result = await runTrain(
      [
        { contractId: "c1", branch: "arm-1" },
        { contractId: "c2", branch: "arm-2" },
      ],
      { repo, trunk: "main", gates: [{ command: "./check.sh" }] },
    );
    const byId = Object.fromEntries(result.outcomes.map((o) => [o.contractId, o]));
    expect(byId.c1!.status).toBe("ejected");
    expect((byId.c1 as { reason: string }).reason).toBe("gate-failed");
    expect(byId.c2!.status).toBe("merged");
    // trunk advanced only to the gated state (c2), never to the red one
    expect(await revParse(repo, "main")).toBe(result.trunkAfter);
  });
});

describe("atomic group merge", () => {
  it("merges entangled cars together when each fails the gate alone", async () => {
    // check-pair.sh passes only when BOTH halves exist — each car alone is red.
    const g = (...args: string[]) =>
      execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" }).toString();
    writeFileSync(join(repo, "check-pair.sh"), "#!/bin/sh\ntest -f half-a.txt && test -f half-b.txt\n");
    execFileSync("chmod", ["+x", join(repo, "check-pair.sh")]);
    g("add", "-A"); g("commit", "-qm", "add pair gate");
    branchWithChange(repo, "arm-a", "half-a.txt", "a\n");
    branchWithChange(repo, "arm-b", "half-b.txt", "b\n");
    const result = await runTrain(
      [
        { contractId: "a", branch: "arm-a" },
        { contractId: "b", branch: "arm-b" },
      ],
      { repo, trunk: "main", gates: [{ command: "./check-pair.sh" }] },
    );
    expect(result.outcomes.map((o) => o.status)).toEqual(["merged", "merged"]);
    expect(result.trunkAfter).not.toBe(result.trunkBefore);
    expect(await revParse(repo, "main")).toBe(result.trunkAfter);
  });
});
