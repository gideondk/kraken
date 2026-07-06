import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { createHash } from "node:crypto";

/**
 * A skill pack is a directory of Claude-convention skills (SKILL.md + reference
 * files) plus routing metadata. Packs are versioned artifacts that travel with
 * the dependencies they describe — a repo can resolve
 * them at the version matching its NuGet reference.
 */
export interface Skill {
  name: string;
  description: string;
  /** Full SKILL.md content — injected verbatim when routed to a worker. */
  content: string;
  /** Sibling reference files, loaded lazily by workers that need depth. */
  referenceFiles: string[];
  dir: string;
  contentHash: string;
}

export function loadSkill(dir: string): Skill {
  const skillMd = join(dir, "SKILL.md");
  const content = readFileSync(skillMd, "utf8");
  const fm = parseFrontmatter(content);
  const referenceFiles = readdirSync(dir).filter(
    (f) => f !== "SKILL.md" && f.endsWith(".md"),
  );
  return {
    name: fm.name ?? basename(dir),
    description: fm.description ?? "",
    content,
    referenceFiles,
    dir,
    contentHash: createHash("sha256").update(content).digest("hex").slice(0, 16),
  };
}

/** Load every skill under a root (each subdirectory containing SKILL.md). */
export function loadPack(root: string): Skill[] {
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .map((d) => join(root, d))
    .filter((d) => statSync(d).isDirectory() && existsSync(join(d, "SKILL.md")))
    .map(loadSkill);
}

function parseFrontmatter(content: string): { name?: string; description?: string } {
  const m = content.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return {};
  const out: { name?: string; description?: string } = {};
  const nameM = m[1]!.match(/^name:\s*(.+)$/m);
  if (nameM) out.name = nameM[1]!.trim();
  const descM = m[1]!.match(/^description:\s*([\s\S]*?)(?=\n\w+:|$)/m);
  if (descM) out.description = descM[1]!.replace(/\n\s+/g, " ").trim();
  return out;
}
