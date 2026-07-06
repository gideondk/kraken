import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { git, revParse } from "@kraken/train";

/** One worktree per contract, on its own branch. Write isolation by construction. */
export async function createArmWorktree(
  repo: string,
  contractId: string,
  baseRef: string,
  root: string,
  reuseBranch = false,
): Promise<{ worktree: string; branch: string }> {
  const branch = `kraken/${contractId}`;
  const worktree = join(root, contractId);
  await mkdir(root, { recursive: true });
  await git(repo, ["worktree", "remove", "--force", worktree]);
  await rm(worktree, { recursive: true, force: true }).catch(() => {});
  const existing = await revParse(repo, branch);
  if (reuseBranch && existing) {
    // Fix-forward: judged work stays; the repair arm continues on the branch.
    const res = await git(repo, ["worktree", "add", worktree, branch]);
    if (!res.ok) throw new Error(`worktree reuse failed for ${contractId}: ${res.stderr}`);
    return { worktree, branch };
  }
  await git(repo, ["branch", "-D", branch]);
  const res = await git(repo, ["worktree", "add", "-b", branch, worktree, baseRef]);
  if (!res.ok) throw new Error(`worktree add failed for ${contractId}: ${res.stderr}`);
  return { worktree, branch };
}

/**
 * The harness owns the commit, not the worker: headless permission modes often
 * allow file edits but not `git commit`, so hoping the worker committed is a
 * silent-empty-merge bug. Commits anything uncommitted; reports whether the
 * branch actually diverged from its base.
 */
export async function commitArmWork(
  worktree: string,
  contractId: string,
  objective: string,
  baseRef: string,
): Promise<"committed" | "no-changes"> {
  const status = await git(worktree, ["status", "--porcelain"]);
  if (status.stdout.trim().length > 0) {
    await git(worktree, ["add", "-A"]);
    const commit = await git(worktree, [
      "-c", "user.email=kraken@local",
      "-c", "user.name=kraken",
      "commit", "-m", `kraken(${contractId}): ${objective.slice(0, 100)}`,
    ]);
    if (!commit.ok) throw new Error(`commit failed in ${worktree}: ${commit.stderr}`);
    return "committed";
  }
  const head = await revParse(worktree, "HEAD");
  const base = await revParse(worktree, baseRef);
  return head !== null && head !== base ? "committed" : "no-changes";
}

export async function removeArmWorktree(repo: string, worktree: string): Promise<void> {
  await git(repo, ["worktree", "remove", "--force", worktree]);
  await rm(worktree, { recursive: true, force: true }).catch(() => {});
}
