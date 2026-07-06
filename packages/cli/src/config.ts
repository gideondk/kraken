import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { RunConfig } from "./run.ts";

/**
 * kraken.toml, minimal hand-rolled parse (flat keys + [[rules]] blocks) so we
 * carry no TOML dependency for a config this small. Falls back to defaults.
 */
export function loadConfig(repo: string): RunConfig {
  const defaults: RunConfig = {
    repo,
    trunk: "main",
    gates: [],
    skillRoots: [join(repo, ".claude", "skills"), join(repo, "skills")],
    routingRules: [],
    allowedTools: [],
    maxParallel: 4,
    defaultArm: "claude",
    arms: [],
    autoHeal: true,
    maxHeals: 2,
  };
  const path = join(repo, "kraken.toml");
  if (!existsSync(path)) return defaults;

  const src = readFileSync(path, "utf8");
  const str = (key: string): string | undefined =>
    src.match(new RegExp(`^${key}\\s*=\\s*"([^"]*)"`, "m"))?.[1];
  const num = (key: string): number | undefined => {
    const m = src.match(new RegExp(`^${key}\\s*=\\s*(\\d+)`, "m"));
    return m ? Number(m[1]) : undefined;
  };
  const bool = (key: string): boolean | undefined => {
    const m = src.match(new RegExp(`^${key}\\s*=\\s*(true|false)`, "m"));
    return m ? m[1] === "true" : undefined;
  };
  const strArray = (key: string): string[] | undefined => {
    const m = src.match(new RegExp(`^${key}\\s*=\\s*\\[([^\\]]*)\\]`, "m"));
    if (!m) return undefined;
    return [...m[1]!.matchAll(/"([^"]*)"/g)].map((x) => x[1]!);
  };

  const rules = [...src.matchAll(/\[\[rules\]\]([\s\S]*?)(?=\[\[|$)/g)].map((block) => {
    const b = block[1]!;
    const field = (k: string) => b.match(new RegExp(`${k}\\s*=\\s*"([^"]*)"`))?.[1];
    const list = (k: string) => {
      const m = b.match(new RegExp(`${k}\\s*=\\s*\\[([^\\]]*)\\]`));
      return m ? [...m[1]!.matchAll(/"([^"]*)"/g)].map((x) => x[1]!) : undefined;
    };
    return {
      skill: field("skill") ?? "",
      ...(list("paths") ? { pathPatterns: list("paths")! } : {}),
      ...(list("terms") ? { objectiveTerms: list("terms")! } : {}),
      ...(b.includes("always = true") ? { always: true } : {}),
    };
  }).filter((r) => r.skill);

  const arms = [...src.matchAll(/\[\[arms\]\]([\s\S]*?)(?=\[\[|$)/g)].map((block) => {
    const b = block[1]!;
    const field = (k: string) => b.match(new RegExp(`${k}\\s*=\\s*"([^"]*)"`))?.[1];
    const list = (k: string) => {
      const m = b.match(new RegExp(`${k}\\s*=\\s*\\[([^\\]]*)\\]`));
      return m ? [...m[1]!.matchAll(/"([^"]*)"/g)].map((x) => x[1]!) : undefined;
    };
    const tierArgs: Record<string, string[]> = {};
    for (const tier of ["fast", "standard", "frontier"] as const) {
      const args = list(`${tier}_args`);
      if (args) tierArgs[tier] = args;
    }
    return {
      harness: field("name") ?? "",
      command: list("command") ?? [],
      ...(Object.keys(tierArgs).length ? { tierArgs } : {}),
    };
  }).filter((a) => a.harness && a.command.length > 0);

  const notifyUrl = str("notify_url");
  return {
    repo,
    trunk: str("trunk") ?? defaults.trunk,
    gates: (strArray("gates") ?? []).map((command) => ({ command })),
    allowedTools: strArray("allowed_tools") ?? [],
    skillRoots: strArray("skill_roots")?.map((p) => join(repo, p)) ?? defaults.skillRoots,
    routingRules: rules,
    maxParallel: num("max_parallel") ?? defaults.maxParallel,
    defaultArm: str("default_arm") ?? defaults.defaultArm,
    arms,
    autoHeal: bool("auto_heal") ?? defaults.autoHeal,
    maxHeals: num("max_heals") ?? defaults.maxHeals,
    ...(notifyUrl ? { notifyUrl } : {}),
  };
}
