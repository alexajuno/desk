// desk's settings, as Linear's Settings pages keep them: one file, DATA_DIR/settings.json, beside the issues, so the data
// repo keeps them too. A setting the file does not name has its default.
//
//     sub_issue_auto_close   a parent closed as Done or Dropped closes its open sub-issues the same way
//     parent_auto_close      the last open sub-issue closed closes its parent
//
// Linear keeps both in Settings > Team > Workflow (linear.app/docs/parent-and-sub-issues#status-automation); desk has
// no teams, so they are Settings > Workflow.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./config.ts";

export interface Settings {
  sub_issue_auto_close: boolean;
  parent_auto_close: boolean;
}

// Sub-issue auto-close is on from the start, as the user asked for it (17 Oct); Parent auto-close is off, Linear's default.
export const DEFAULTS: Settings = { sub_issue_auto_close: true, parent_auto_close: false };

const FILE = join(DATA_DIR, "settings.json");

export function load(): Settings {
  let saved: Record<string, unknown> = {};
  try {
    if (existsSync(FILE)) saved = JSON.parse(readFileSync(FILE, "utf8"));
  } catch {
    // a file broken by hand counts as none
  }
  const found = { ...DEFAULTS };
  for (const name of Object.keys(DEFAULTS) as (keyof Settings)[]) if (typeof saved[name] === "boolean") found[name] = saved[name] as boolean;
  return found;
}

// Set the named settings; a name desk does not know, or a value that is not true or false, is refused with why.
export function set(changes: Record<string, unknown>): Settings {
  const next = load();
  for (const [name, value] of Object.entries(changes)) {
    if (!(name in DEFAULTS)) throw new Error(`No setting ${name}. desk has: ${Object.keys(DEFAULTS).join(", ")}.`);
    if (typeof value !== "boolean") throw new Error(`${name} must be true or false.`);
    next[name as keyof Settings] = value;
  }
  writeFileSync(FILE, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return next;
}
