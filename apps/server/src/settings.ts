// desk's settings, as Linear's Settings pages keep them: one row each in the settings table. A setting with no row has
// its default.
//
//     sub_issue_auto_close   a parent closed as Done or Dropped closes its open sub-issues the same way
//     parent_auto_close      the last open sub-issue closed closes its parent
//     chat_model             the model a new desk chat starts with, a Claude Code alias or model id such as opus
//     chat_effort            the effort it starts with: low, medium, high, xhigh or max
//
// Linear keeps the first two in Settings > Team > Workflow (linear.app/docs/parent-and-sub-issues#status-automation);
// desk has no teams, so they are Settings > Workflow. The chat's two are Settings > Preferences.
import { join } from "node:path";
import { DATA_DIR } from "./config.ts";
import * as copies from "./copies.ts";
import * as db from "./db.ts";
import { sql } from "./db.ts";

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

const FILE = join(DATA_DIR, "settings.json"); // where they were until 19 Oct, written out still (copies.ts)
const MODEL = /^[a-z0-9][a-z0-9.\-[\]]{0,79}$/; // an alias or a model id, such as sonnet or claude-opus-5-5[1m]

// Why the value is no good for the setting, or "" when it is.
function wrong(name: keyof Settings, value: unknown): string {
  if (typeof DEFAULTS[name] === "boolean") return typeof value === "boolean" ? "" : `${name} must be true or false.`;
  if (name === "chat_effort") return EFFORTS.includes(value as Effort) ? "" : `chat_effort must be one of ${EFFORTS.join(", ")}.`;
  return typeof value === "string" && MODEL.test(value) ? "" : `${name} must be a model's alias or id, such as opus or sonnet.`;
}

const known = (name: string): name is keyof Settings => name in DEFAULTS;

// What the table holds, kept here as well, since every save of an issue asks (issues.ts, autoClose), inside its write.
let held: Partial<Settings> = {};

// Read the settings, once, as desk starts: those of settings.json first when a desk of an older branch changed it.
export async function open() {
  const text = await copies.changed(FILE);
  if (text !== undefined) {
    let saved: Record<string, unknown> = {};
    try {
      saved = text ? JSON.parse(text) : {};
    } catch {
      // a file broken by hand counts as none
    }
    await db.write(async (tx) => {
      await tx.query("delete from settings");
      for (const [name, value] of Object.entries(saved))
        if (known(name) && !wrong(name, value)) await tx.query("insert into settings values ($1, $2)", [name, JSON.stringify(value)]);
    });
    await copies.taken(FILE, text);
  }
  const rows = (await sql().query<{ name: string; value: unknown }>("select name, value from settings")).rows;
  held = Object.fromEntries(rows.filter((r) => known(r.name) && !wrong(r.name as keyof Settings, r.value)).map((r) => [r.name, r.value]));
}

export const load = (): Settings => ({ ...DEFAULTS, ...held });

// Set the named settings; a name desk does not know, or a value that does not fit it, is refused with why.
export async function set(changes: Record<string, unknown>): Promise<Settings> {
  for (const [name, value] of Object.entries(changes)) {
    if (!known(name)) throw new Error(`No setting ${name}. desk has: ${Object.keys(DEFAULTS).join(", ")}.`);
    const why = wrong(name, value);
    if (why) throw new Error(why);
  }
  await db.write(async (tx) => {
    for (const [name, value] of Object.entries(changes))
      await tx.query("insert into settings values ($1, $2) on conflict (name) do update set value = excluded.value", [name, JSON.stringify(value)]);
  });
  held = { ...held, ...changes };
  const next = load();
  // As the file held them: every setting, with what a branch of its own added.
  await copies.out(FILE, `${JSON.stringify({ ...next, ...copies.others(FILE, Object.keys(DEFAULTS)) }, null, 2)}\n`);
  return next;
}
