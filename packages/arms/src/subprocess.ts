import type { Arm, ArmResult, DispatchInput } from "./arm.ts";
import { renderPrompt, type TierMap } from "./arm.ts";
import { run } from "./claude.ts";

/**
 * Generic subprocess arm — the Vibe Kanban / claw pattern. Wires up any
 * coding CLI that accepts a prompt on stdin (codex, opencode, gemini, ...).
 * Command and per-tier model flags come from kraken.toml.
 */
export interface SubprocessArmConfig {
  harness: string;
  /** e.g. ["codex", "exec", "--json"] — prompt is piped to stdin. */
  command: string[];
  /** Optional flag inserted per tier, e.g. { frontier: ["--model", "o4"] }. */
  tierArgs?: Partial<Record<keyof TierMap, string[]>>;
  timeoutMs?: number;
}

export class SubprocessArm implements Arm {
  readonly harness: string;

  private config: SubprocessArmConfig;

  constructor(config: SubprocessArmConfig) {
    this.config = config;
    this.harness = config.harness;
  }

  async dispatch(input: DispatchInput, onActivity?: (activity: string) => void): Promise<ArmResult> {
    const [cmd, ...baseArgs] = this.config.command;
    if (!cmd) return { ok: false, output: `arm '${this.harness}' has an empty command` };
    const tierArgs = this.config.tierArgs?.[input.modelTier] ?? [];
    const { code, stdout, stderr } = await run(cmd, [...baseArgs, ...tierArgs], {
      cwd: input.worktree,
      stdin: renderPrompt(input),
      timeoutMs: this.config.timeoutMs ?? 30 * 60 * 1000,
      onLine: (line) => { if (line.trim()) onActivity?.(line.trim().slice(0, 110)); },
    });
    return {
      ok: code === 0,
      output: code === 0 ? stdout.trim() : `${stderr}\n${stdout}`.trim(),
    };
  }
}
