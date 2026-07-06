import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

export interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number;
}

/** Run git in a repo. Never throws on non-zero exit — callers read `ok`. */
export async function git(repo: string, args: string[]): Promise<GitResult> {
  try {
    const { stdout, stderr } = await execFileP("git", ["-C", repo, ...args], {
      maxBuffer: 32 * 1024 * 1024,
    });
    return { ok: true, stdout, stderr, code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number };
    return { ok: false, stdout: e.stdout ?? "", stderr: e.stderr ?? "", code: e.code ?? 1 };
  }
}

export async function revParse(repo: string, ref: string): Promise<string | null> {
  const r = await git(repo, ["rev-parse", "--verify", `${ref}^{commit}`]);
  return r.ok ? r.stdout.trim() : null;
}

export async function mergeBase(repo: string, a: string, b: string): Promise<string | null> {
  const r = await git(repo, ["merge-base", a, b]);
  return r.ok ? r.stdout.trim() : null;
}
