import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Journal } from "@kraken/core";

export function krakenHome(): string {
  const home = process.env.KRAKEN_HOME ?? join(homedir(), ".kraken");
  mkdirSync(home, { recursive: true });
  return home;
}

export function openJournal(): Journal {
  return new Journal(join(krakenHome(), "journal.db"));
}

export function worktreeRoot(): string {
  const root = join(krakenHome(), "worktrees");
  mkdirSync(root, { recursive: true });
  return root;
}
