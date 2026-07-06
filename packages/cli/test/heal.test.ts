import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Journal } from "@kraken/core";
import { evaluateHeal, healFingerprint } from "../src/run.ts";

/**
 * Tier two of the ladder (deterministic → self-heal → judge): mechanical
 * ejections self-heal until they no longer can. Everything is journal-derived,
 * so these tests drive evaluateHeal with real journals, no reconcile loop.
 */

const journal = () => new Journal(join(mkdtempSync(join(tmpdir(), "kraken-heal-")), "j.db"));
const cfg = { autoHeal: true, maxHeals: 2 };

const eject = (j: Journal, contractId: string, reason: string) =>
  j.append({ type: "MergeCarEjected", runId: "r1", contractId, reason });

const healDecision = (j: Journal, contractId: string, n: number) =>
  j.append({
    type: "DecisionMade", runId: "r1", decisionId: `eject-${contractId}`, choice: "fix-forward",
    decidedBy: "kraken", annotation: `auto-heal ${n}/2: some gate error`,
  });

describe("auto-heal on ejection", () => {
  it("heals the first mechanical eject", () => {
    const j = journal();
    const v = evaluateHeal(j, "r1", "a", "gate-failed: gate 'pnpm test' failed: error TS2304 in src/foo.ts:12", cfg);
    expect(v).toEqual({ heal: true, attempt: 1, priorAttempts: 0, stalled: false });
  });

  it("stops when the fingerprint repeats (no progress), even with budget left", () => {
    const j = journal();
    eject(j, "a", "gate-failed: gate 'pnpm test' failed: error TS2304 in src/foo.ts:12");
    healDecision(j, "a", 1);
    // Same failure, shifted line number and different temp dir spelling — same fingerprint.
    const stalled = evaluateHeal(j, "r1", "a", "gate-failed: gate 'pnpm test' failed: error TS2304 in lib/src/foo.ts:47", cfg);
    expect(stalled.heal).toBe(false);
    expect(stalled.stalled).toBe(true);
    expect(stalled.priorAttempts).toBe(1);
    // A genuinely different failure is progress — healing continues.
    const progressed = evaluateHeal(j, "r1", "a", "gate-failed: gate 'pnpm test' failed: FAIL reconcile.test.ts assertion mismatch", cfg);
    expect(progressed.heal).toBe(true);
    expect(progressed.attempt).toBe(2);
  });

  it("respects max_heals across distinct failures", () => {
    const j = journal();
    eject(j, "a", "gate-failed: error one in x.ts");
    healDecision(j, "a", 1);
    eject(j, "a", "gate-failed: error two entirely different failure in y.ts");
    healDecision(j, "a", 2);
    const v = evaluateHeal(j, "r1", "a", "gate-failed: error three yet another failure in z.ts", cfg);
    expect(v.heal).toBe(false);
    expect(v.stalled).toBe(false); // budget, not stall
    expect(v.attempt).toBe(3);
    // Another contract's budget is untouched.
    expect(evaluateHeal(j, "r1", "b", "gate-failed: error one in x.ts", cfg).heal).toBe(true);
  });

  it("does nothing when auto_heal is off", () => {
    const j = journal();
    const v = evaluateHeal(j, "r1", "a", "gate-failed: error TS2304 in src/foo.ts:12", { autoHeal: false, maxHeals: 2 });
    expect(v.heal).toBe(false);
    expect(v.stalled).toBe(false);
  });

  it("fingerprints ignore directories and numbers but keep the error identity", () => {
    expect(healFingerprint("gate-failed: error TS2304 in /Users/x/dev/repo/src/foo.ts:12"))
      .toBe(healFingerprint("gate-failed: error TS2304 in …/other/src/foo.ts:99"));
    expect(healFingerprint("gate-failed: error TS2304 in src/foo.ts:12"))
      .not.toBe(healFingerprint("gate-failed: error CS0169 in src/foo.ts:12"));
  });
});
