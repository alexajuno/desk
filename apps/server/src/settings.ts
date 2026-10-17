// desk's settings, as Linear's Settings pages keep them: one file, DATA_DIR/settings.json, beside the issues, so the data
// repo keeps them too. A setting the file does not name has its default.
//
//     sub_issue_auto_close   a parent closed as Done or Dropped closes its open sub-issues the same way
//     parent_auto_close      the last open sub-issue closed closes its parent
//     chat_model             the model a new desk chat starts with, a Claude Code alias or model id such as opus
//     chat_effort            the effort it starts with: low, medium, high, xhigh or max
//
// Linear keeps the first two in Settings > Team > Workflow (linear.app/docs/parent-and-sub-issues#status-automation);
// desk has no teams, so they are Settings > Workflow. The chat's two are Settings > Preferences.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./config.ts";

export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];

export interface Settings {
  sub_issue_auto_close: boolean;
  parent_auto_close: boolean;
  chat_model: string;
  chat_effort: Effort;
}

// Sub-issue auto-close is on from the start, as the user asked for it (17 Oct); Parent auto-close is off, Linear's default.
// A chat starts on Opus at extra high effort, as every chat ran before the setting.
export const DEFAULTS: Settings = { sub_issue_auto_close: true, parent_auto_close: false, chat_model: "opus", chat_effort: "xhigh" };

const FILE = join(DATA_DIR, "settings.json");
const MODEL = /^[a-z0-9][a-z0-9.\-[\]]{0,79}$/; // an alias or a model id, such as sonnet or claude-opus-5-5[1m]

// Why the value is no good for the setting, or "" when it is.
function wrong(name: keyof Settings, value: unknown): string {
  if (typeof DEFAULTS[name] === "boolean") return typeof value === "boolean" ? "" : `${name} must be true or false.`;
  if (name === "chat_effort") return EFFORTS.includes(value as Effort) ? "" : `chat_effort must be one of ${EFFORTS.join(", ")}.`;
  return typeof value === "string" && MODEL.test(value) ? "" : `${name} must be a model's alias or id, such as opus or sonnet.`;
}

export function load(): Settings {
  let saved: Record<string, unknown> = {};
  try {
    if (existsSync(FILE)) saved = JSON.parse(readFileSync(FILE, "utf8"));
  } catch {
    // a file broken by hand counts as none
  }
  const found: Record<string, unknown> = { ...DEFAULTS };
  for (const name of Object.keys(DEFAULTS) as (keyof Settings)[]) if (name in saved && !wrong(name, saved[name])) found[name] = saved[name];
  return found as unknown as Settings;
}

// Set the named settings; a name desk does not know, or a value that does not fit it, is refused with why.
export function set(changes: Record<string, unknown>): Settings {
  const next: Record<string, unknown> = { ...load() };
  for (const [name, value] of Object.entries(changes)) {
    if (!(name in DEFAULTS)) throw new Error(`No setting ${name}. desk has: ${Object.keys(DEFAULTS).join(", ")}.`);
    const why = wrong(name as keyof Settings, value);
    if (why) throw new Error(why);
    next[name] = value;
  }
  writeFileSync(FILE, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return next as unknown as Settings;
}
