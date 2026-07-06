import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { nextTier, parseVerdict, runCheckpointGates } from "../src/index.ts";

describe("verdict parsing", () => {
  it("parses a clean JSON verdict", () => {
    const v = parseVerdict('{"score": 0.9, "pass": true, "rationale": "tests green, boundaries respected"}');
    expect(v).toEqual({ score: 0.9, pass: true, rationale: "tests green, boundaries respected", mustFix: [] });
  });

  it("survives fences, prose, and braces inside strings", () => {
    const v = parseVerdict(
      'Here is my assessment:\n```json\n{"score": 0.4, "pass": false, "rationale": "missing {edge} case in schedule"}\n```\nLet me know.',
    );
    expect(v?.pass).toBe(false);
    expect(v?.rationale).toContain("{edge}");
  });

  it("clamps scores and rejects garbage", () => {
    expect(parseVerdict('{"score": 3, "pass": true, "rationale": "x"}')?.score).toBe(1);
    expect(parseVerdict("no json here")).toBeNull();
    expect(parseVerdict('{"score": "high"}')).toBeNull();
  });
});

describe("escalation ladder", () => {
  it("climbs fast → standard → frontier → exhausted", () => {
    expect(nextTier("fast")).toBe("standard");
    expect(nextTier("standard")).toBe("frontier");
    expect(nextTier("frontier")).toBeNull();
  });
});

describe("checkpoint gates", () => {
  it("runs gates in the worktree and captures failures as evidence", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kraken-judge-"));
    writeFileSync(join(dir, "ok.sh"), "#!/bin/sh\necho fine\n");
    writeFileSync(join(dir, "bad.sh"), "#!/bin/sh\necho broken >&2\nexit 1\n");
    execFileSync("chmod", ["+x", join(dir, "ok.sh"), join(dir, "bad.sh")]);
    const outcomes = await runCheckpointGates(dir, ["./ok.sh", "./bad.sh"]);
    expect(outcomes[0]).toMatchObject({ gate: "./ok.sh", passed: true });
    expect(outcomes[1]!.passed).toBe(false);
    expect(outcomes[1]!.output).toContain("broken");
  });
});
