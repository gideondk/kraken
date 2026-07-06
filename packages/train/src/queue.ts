import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { git, revParse } from "./git.ts";
import { simulateMerge } from "./radar.ts";

const execFileP = promisify(execFile);

export interface MergeCar {
  contractId: string;
  branch: string;
}

export interface GateSpec {
  /** e.g. "pnpm test" or "dotnet test" — run at repo root of the candidate tree. */
  command: string;
  timeoutMs?: number;
}

export type CarOutcome =
  | { contractId: string; branch: string; status: "merged"; commit: string }
  | { contractId: string; branch: string; status: "ejected"; reason: string; detail: string };

export interface TrainRunResult {
  trunkBefore: string;
  trunkAfter: string;
  outcomes: CarOutcome[];
}

export interface TrainOptions {
  repo: string;
  trunk: string;
  gates: GateSpec[];
  onProgress?: (msg: string) => void;
}

/**
 * Speculative merge queue (SubmitQueue pattern, single-pipeline form):
 * each car is validated against the PREDICTED trunk — the result of all cars
 * ahead of it — not the current trunk. A failing car is ejected alone; the
 * cars behind it revalidate against the corrected prediction. Trunk only
 * advances at the end, atomically, and only to a fully gated state.
 */
export async function runTrain(cars: MergeCar[], opts: TrainOptions): Promise<TrainRunResult> {
  const { repo, trunk, gates, onProgress = () => {} } = opts;
  const trunkBefore = await revParse(repo, trunk);
  if (!trunkBefore) throw new Error(`trunk '${trunk}' not found in ${repo}`);

  let predicted = trunkBefore;
  const outcomes: CarOutcome[] = [];

  for (const car of cars) {
    onProgress(`car ${car.contractId}: simulating merge of ${car.branch} onto predicted HEAD`);
    const branchTip = await revParse(repo, car.branch);
    if (!branchTip) {
      outcomes.push({ ...car, status: "ejected", reason: "branch-missing", detail: `branch ${car.branch} not found` });
      continue;
    }

    const sim = await simulateMerge(repo, predicted, branchTip);
    if (!sim.clean || !sim.tree) {
      outcomes.push({
        ...car,
        status: "ejected",
        reason: "textual-conflict",
        detail: `conflicts with predicted HEAD in: ${sim.conflictedFiles.join(", ") || "unknown files"}`,
      });
      continue; // prediction unchanged; next car validates against it
    }

    // Materialize the speculative merge commit (no working tree involved).
    const commitRes = await git(repo, [
      "commit-tree", sim.tree,
      "-p", predicted,
      "-p", branchTip,
      "-m", `kraken-train: merge ${car.branch} (${car.contractId})`,
    ]);
    if (!commitRes.ok) {
      outcomes.push({ ...car, status: "ejected", reason: "commit-failed", detail: commitRes.stderr });
      continue;
    }
    const candidate = commitRes.stdout.trim();

    // Textual merge success is not an integration gate: semantic conflicts
    // pass the merge and break the build. Every car compiles and tests.
    const gateFailure = await runGates(repo, candidate, gates, onProgress);
    if (gateFailure) {
      outcomes.push({ ...car, status: "ejected", reason: "gate-failed", detail: gateFailure });
      continue;
    }

    predicted = candidate;
    outcomes.push({ ...car, status: "merged", commit: candidate });
    onProgress(`car ${car.contractId}: green, predicted HEAD advanced`);
  }

  // Entangled-wave repair: cars that fail alone are often each other's missing
  // half (an atomic migration split across contracts). Before giving up, try
  // all gate-failed cars as ONE candidate — still fully gated, never blind.
  const ejectedCars = outcomes.filter(
    (o): o is Extract<CarOutcome, { status: "ejected" }> =>
      o.status === "ejected" && (o.reason === "gate-failed" || o.reason === "textual-conflict"),
  );
  if (ejectedCars.length >= 2) {
    onProgress(`attempting atomic group merge of ${ejectedCars.length} ejected cars`);
    let candidate = predicted;
    let clean = true;
    for (const car of ejectedCars) {
      const tip = await revParse(repo, car.branch);
      if (!tip) { clean = false; break; }
      const sim = await simulateMerge(repo, candidate, tip);
      if (!sim.clean || !sim.tree) { clean = false; break; }
      const commit = await git(repo, [
        "commit-tree", sim.tree, "-p", candidate, "-p", tip,
        "-m", `kraken-train: group merge ${car.branch}`,
      ]);
      if (!commit.ok) { clean = false; break; }
      candidate = commit.stdout.trim();
    }
    if (clean && candidate !== predicted) {
      const groupFailure = await runGates(repo, candidate, gates, onProgress);
      if (!groupFailure) {
        predicted = candidate;
        for (const car of ejectedCars) {
          const i = outcomes.findIndex((o) => o.contractId === car.contractId);
          outcomes[i] = { contractId: car.contractId, branch: car.branch, status: "merged", commit: candidate };
        }
        onProgress(`atomic group merged: ${ejectedCars.map((c) => c.contractId).join(" + ")} — green together`);
      } else {
        onProgress(`atomic group also failed gates — real defects, not entanglement`);
      }
    }
  }

  let trunkAfter = trunkBefore;
  if (predicted !== trunkBefore) {
    // Atomic advance: refuses if trunk moved underneath us since trunkBefore.
    const upd = await git(repo, ["update-ref", `refs/heads/${trunk}`, predicted, trunkBefore]);
    if (!upd.ok) throw new Error(`trunk moved during train run; not advancing: ${upd.stderr}`);
    trunkAfter = predicted;
  }
  return { trunkBefore, trunkAfter, outcomes };
}

/** Check out the candidate commit in a throwaway worktree and run every gate. */
async function runGates(
  repo: string,
  commit: string,
  gates: GateSpec[],
  onProgress: (msg: string) => void,
): Promise<string | null> {
  if (gates.length === 0) return null;
  const wt = await mkdtemp(join(tmpdir(), "kraken-gate-"));
  const add = await git(repo, ["worktree", "add", "--detach", wt, commit]);
  if (!add.ok) return `worktree add failed: ${add.stderr}`;
  try {
    for (const gate of gates) {
      onProgress(`gate: ${gate.command}`);
      const [cmd, ...args] = gate.command.split(" ");
      try {
        await execFileP(cmd!, args, { cwd: wt, timeout: gate.timeoutMs ?? 600_000, maxBuffer: 32 * 1024 * 1024 });
      } catch (err) {
        const e = err as { stdout?: string; stderr?: string };
        const tail = `${e.stdout ?? ""}\n${e.stderr ?? ""}`.trim().split("\n").slice(-25).join("\n");
        return `gate '${gate.command}' failed:\n${tail}`;
      }
    }
    return null;
  } finally {
    await git(repo, ["worktree", "remove", "--force", wt]);
    await rm(wt, { recursive: true, force: true }).catch(() => {});
  }
}
