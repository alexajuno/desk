// desk's settings, as Linear's Settings pages keep them: one row each in the settings table. A setting with no row has
// its default.
//
//     sub_issue_auto_close   a parent closed as Done or Dropped closes its open sub-issues the same way
//     parent_auto_close      the last open sub-issue closed closes its parent
//     chat_model             the model a new desk chat or issue session starts with, a Claude Code alias or model id such as opus
//     chat_effort            the effort it starts with: low, medium, high, xhigh or max
//     stash_back_on_send     what Ctrl S put away comes back into the composer as the next message is entered, as
//                            Claude Code's stash does; off, it waits in its chip for Ctrl S
//     test_slots             how many test desks run at once (pool.ts), from 1 to 4
//
// Linear keeps the first two in Settings > Team > Workflow (linear.app/docs/parent-and-sub-issues#status-automation);
// desk has no teams, so they are Settings > Workflow. The sessions' three, the steps card and the stash are Settings > Preferences.
import * as db from "./db.ts";
import { sql } from "./db.ts";

export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];

export interface Settings {
  sub_issue_auto_close: boolean;
  parent_auto_close: boolean;
  chat_model: string;
  chat_effort: Effort;
  stash_back_on_send: boolean;
  test_slots: number;
}

// Sub-issue auto-close is on from the start, as the user asked for it (17 Oct); Parent auto-close is off, Linear's default.
// A chat starts on Opus at extra high effort, as every chat ran before the setting. The steps card starts collapsed, as
// the user asked with the setting ("set it to collapse by default", 1 Nov). One test desk runs at a time, as the user
// asked ("my machine's resource likely won't be able to handle that... likely just start at one", 2 Nov). The stash comes
// back on the next message, as Claude Code's does ("mirror claude's stash msg", 4 Nov).
export const DEFAULTS: Settings = {
  sub_issue_auto_close: true, parent_auto_close: false, chat_model: "opus", chat_effort: "xhigh",
  stash_back_on_send: true, test_slots: 1,
};
export const MAX_SLOTS = 4;

const MODEL = /^[a-z0-9][a-z0-9.\-[\]]{0,79}$/; // an alias or a model id, such as sonnet or claude-opus-5-5[1m]

// Why the value is no good for the setting, or "" when it is.
function wrong(name: keyof Settings, value: unknown): string {
  if (typeof DEFAULTS[name] === "boolean") return typeof value === "boolean" ? "" : `${name} must be true or false.`;
  if (name === "chat_effort") return EFFORTS.includes(value as Effort) ? "" : `chat_effort must be one of ${EFFORTS.join(", ")}.`;
  if (name === "test_slots") return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= MAX_SLOTS ? "" : `test_slots must be a whole number from 1 to ${MAX_SLOTS}.`;
  return typeof value === "string" && MODEL.test(value) ? "" : `${name} must be a model's alias or id, such as opus or sonnet.`;
}

const known = (name: string): name is keyof Settings => name in DEFAULTS;

// What the table holds, kept here as well, since every save of an issue asks (issues.ts, autoClose), inside its write.
let held: Partial<Settings> = {};

// Read the settings, once, as desk starts.
export async function open() {
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
  return load();
}
