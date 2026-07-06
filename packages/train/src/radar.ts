import { git } from "./git.ts";

export interface ConflictWarning {
  branchA: string;
  branchB: string;
  files: string[];
}

/**
 * Pre-write conflict radar: read-only three-way merge simulation between
 * every pair of live branches using `git merge-tree --write-tree` (in-memory,
 * never touches the working tree). Surfaces collisions while they are still
 * one conversation instead of a merge failure an hour later.
 */
export async function radar(repo: string, branches: string[]): Promise<ConflictWarning[]> {
  const warnings: ConflictWarning[] = [];
  for (let i = 0; i < branches.length; i++) {
    for (let j = i + 1; j < branches.length; j++) {
      const a = branches[i]!;
      const b = branches[j]!;
      const sim = await simulateMerge(repo, a, b);
      if (!sim.clean) warnings.push({ branchA: a, branchB: b, files: sim.conflictedFiles });
    }
  }
  return warnings;
}

export interface MergeSimulation {
  clean: boolean;
  /** Tree oid of the merged result (present even on conflict, with conflict markers). */
  tree: string | null;
  conflictedFiles: string[];
}

export async function simulateMerge(
  repo: string,
  refA: string,
  refB: string,
): Promise<MergeSimulation> {
  const r = await git(repo, ["merge-tree", "--write-tree", "--name-only", refA, refB]);
  const lines = r.stdout.split("\n").filter((l) => l.length > 0);
  const tree = lines[0] ?? null;
  if (r.ok) return { clean: true, tree, conflictedFiles: [] };
  // Exit code 1 = conflicts; with --name-only the lines after the tree oid
  // (up to the first blank-line-separated section) are conflicted paths.
  const conflictedFiles = lines.slice(1).filter((l) => !l.startsWith("CONFLICT"));
  return { clean: false, tree, conflictedFiles };
}
