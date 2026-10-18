// The user's own Claude Code agents (~/.claude/agents/*.md, such as psychiatrist and coach), whom desk's chats talk to.
// @name at the start of a new chat makes the chat that agent's, and a script starts one with a message for the user
// (POST /api/agents/<name>/say). "psy = any agent" (the user, 18 Oct): desk treats none of them specially.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { HOME } from "./config.ts";
import { split } from "./frontmatter.ts";
import { EFFORTS, type Effort } from "./settings.ts";

const DIR = join(HOME, ".claude", "agents");

export interface Agent {
  name: string;
  description: string; // its first sentence, for the composer's list
  model?: string; // none for "inherit"
  effort?: Effort; // which `claude --agent` leaves out, so desk passes it, as bin/coach does
}

export function list(): Agent[] {
  if (!existsSync(DIR)) return [];
  return readdirSync(DIR).filter((file) => file.endsWith(".md")).flatMap((file): Agent[] => {
    let meta: Record<string, unknown>;
    try {
      meta = split(readFileSync(join(DIR, file), "utf8")).meta;
    } catch {
      return []; // front matter broken by hand: Claude Code would not load it either
    }
    const name = typeof meta.name === "string" ? meta.name : file.slice(0, -3);
    const description = String(meta.description ?? "").split(/(?<=\.)\s/)[0];
    const model = typeof meta.model === "string" && meta.model !== "inherit" ? meta.model : undefined;
    const effort = EFFORTS.find((e) => e === meta.effort);
    return [{ name, description, ...(model ? { model } : {}), ...(effort ? { effort } : {}) }];
  }).sort((a, b) => a.name.localeCompare(b.name));
}

export const find = (name: string): Agent | null => list().find((a) => a.name === name) ?? null;
