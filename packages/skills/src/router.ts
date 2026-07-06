import type { TaskContract } from "@kraken/core";
import type { Skill } from "./pack.ts";

/**
 * Deterministic task→skill routing. Context rot is measured: injecting all
 * skills degrades recall, so each worker gets only what its contract needs.
 * Rules first (auditable, reproducible); a classifier can refine later.
 */
export interface RoutingRule {
  skill: string;
  /** Route when any owned path matches one of these globs. */
  pathPatterns?: string[];
  /** Route when the objective mentions any of these terms (case-insensitive). */
  objectiveTerms?: string[];
  /** Always inject (process skills like a TDD loop). Use sparingly. */
  always?: boolean;
}

export interface RoutedSkills {
  skills: Skill[];
  /** Why each skill was chosen — part of the audit trail. */
  reasons: Record<string, string>;
  /** Names the contract asked for but no pack provides. Surfaced, never silent. */
  missing: string[];
}

const MAX_SKILLS_PER_CONTRACT = 4;

export function routeSkills(
  contract: TaskContract,
  available: Skill[],
  rules: RoutingRule[],
): RoutedSkills {
  const byName = new Map(available.map((s) => [s.name, s]));
  const chosen = new Map<string, string>(); // name → reason
  const missing: string[] = [];

  // 1. Explicit requests in the contract win.
  for (const name of contract.skills) {
    if (byName.has(name)) chosen.set(name, "requested by contract");
    else missing.push(name);
  }

  // 2. Rules fill remaining slots.
  for (const rule of rules) {
    if (chosen.size >= MAX_SKILLS_PER_CONTRACT) break;
    if (chosen.has(rule.skill) || !byName.has(rule.skill)) continue;
    if (rule.always) {
      chosen.set(rule.skill, "always-on process skill");
      continue;
    }
    const pathHit = rule.pathPatterns?.find((p) =>
      contract.boundaries.ownsPaths.some((owned) => globMatch(p, owned)),
    );
    if (pathHit) {
      chosen.set(rule.skill, `owns path matching ${pathHit}`);
      continue;
    }
    const termHit = rule.objectiveTerms?.find((t) =>
      contract.objective.toLowerCase().includes(t.toLowerCase()),
    );
    if (termHit) chosen.set(rule.skill, `objective mentions "${termHit}"`);
  }

  const names = [...chosen.keys()].slice(0, MAX_SKILLS_PER_CONTRACT);
  return {
    skills: names.map((n) => byName.get(n)!),
    reasons: Object.fromEntries(names.map((n) => [n, chosen.get(n)!])),
    missing,
  };
}

/** Render routed skills as the context block prepended to a worker's prompt. */
export function renderSkillBlock(routed: RoutedSkills, allAvailable: Skill[]): string {
  const injected = routed.skills
    .map((s) => `<skill name="${s.name}">\n${s.content}\n</skill>`)
    .join("\n\n");
  const manifest = allAvailable
    .filter((s) => !routed.skills.some((r) => r.name === s.name))
    .map((s) => `- ${s.name}: ${s.description.slice(0, 140)}`)
    .join("\n");
  return [
    "# Injected skills (follow these exactly — they are your team's process)",
    injected,
    "# Other available skills (read their SKILL.md from disk if the task turns out to need them)",
    manifest,
  ].join("\n\n");
}

/** Minimal glob: `**` crosses directories, `*` within a segment. */
export function globMatch(pattern: string, path: string): boolean {
  const DOUBLE = "\u0001";
  const rx = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, DOUBLE)
    .replace(/\*/g, "[^/]*")
    .replaceAll(DOUBLE, ".*");
  return new RegExp(`^${rx}$`).test(path);
}
