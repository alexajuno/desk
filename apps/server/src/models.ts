// The model and effort each session runs on, which the composer's chip shows and changes, and the account's usage,
// which the chip's menu shows. A session's pick is kept in the session_models table, by session id, so it holds when
// the host starts the session again; a session with no pick runs as it started: a desk chat on Settings >
// Preferences (settings.ts), any other on Claude Code's own default (~/.claude/settings.json).
//
// The list of models and the usage come from Claude Code itself, asked by one started only for the question (as the
// SDK's supportedModels and the call behind /usage), with no message, no settings and no transcript, so it costs
// nothing and leaves no trace. desk asks it here rather than in the session host, which may still run older code, and
// keeps the answers, with each reply's usage and each session's context, so the menu never waits on one.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { query, type ModelInfo, type Query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { DATA_DIR, HOME } from "./config.ts";
import * as copies from "./copies.ts";
import * as db from "./db.ts";
import { sql } from "./db.ts";
import * as hosted from "./hosted.ts";
import { run, which } from "./proc.ts";
import * as settings from "./settings.ts";
import * as turns from "./turns.ts";
import { EFFORTS, type Effort } from "./settings.ts";

export interface Pick {
  model?: string;
  effort?: Effort;
}

// What the chip shows: the model's value and name, and the effort, "" when Claude Code's default is unknown.
export interface Shown {
  model: string;
  name: string;
  effort: string;
}

export interface Model {
  value: string;
  name: string;
  efforts: string[]; // none for a model without effort levels, such as Haiku
}

// --- the picks -----------------------------------------------------------------------------------------------------

const FILE = join(DATA_DIR, "session-models.json"); // where they were until 19 Oct, written out still (copies.ts)

// What the table holds, kept here as well, since the chip and the sidebar ask for every session they show.
let picks: Record<string, Pick> = {};

const fit = (pick: Pick): Pick => ({ ...(typeof pick.model === "string" && { model: pick.model }), ...(EFFORTS.includes(pick.effort!) && { effort: pick.effort }) });

// Read the picks, once, as desk starts: those of session-models.json first when a desk of an older branch changed it.
export async function open() {
  const text = await copies.changed(FILE);
  if (text !== undefined) {
    let saved: Record<string, Pick> = {};
    try {
      saved = text ? JSON.parse(text) : {};
    } catch {
      // a file broken by hand counts as none
    }
    await db.write(async (tx) => {
      await tx.query("delete from session_models");
      for (const [session, pick] of Object.entries(saved)) {
        const { model = null, effort = null } = fit(pick ?? {});
        await tx.query("insert into session_models values ($1, $2, $3)", [session, model, effort]);
      }
    });
    await copies.taken(FILE, text);
  }
  const rows = (await sql().query<{ session: string; model: string | null; effort: Effort | null }>("select * from session_models")).rows;
  picks = Object.fromEntries(rows.map((r) => [r.session, fit({ model: r.model ?? undefined, effort: r.effort ?? undefined })]));
  await listen();
}

export const pickOf = (session: string): Pick => picks[session] ?? {};

export const keep = (session: string, pick: Pick) => save(session, { ...picks[session], ...fit(pick) });

// Kept here before the table, so that a pick made while this one is written, such as /effort right after /model, adds
// to it rather than to the one before.
async function save(session: string, pick: Pick) {
  const { model = null, effort = null } = pick;
  picks = { ...picks, [session]: fit(pick) };
  await db.write((tx) => tx.query(`insert into session_models values ($1, $2, $3)
    on conflict (session) do update set model = excluded.model, effort = excluded.effort`, [session, model, effort]));
  await copies.out(FILE, `${JSON.stringify(picks, null, 2)}\n`);
}

// A /model or /effort typed in the session itself, as Claude Code ran it (transcript.ts, commandRun): kept as the
// chip's picks are, so the chip shows it and the host starts the session again on it. Only what Claude Code says it set
// counts, as 2.1.285 words it: "Set model to `Sonnet 5.5`", "Set effort level to low", and "Effort level set to auto",
// the model's own, which drops the effort picked. "Model 'x' not found" leaves the pick as it was.
export async function ran(session: string, run: { command: string; args: string; said: string }) {
  const arg = run.args.toLowerCase(); // Claude Code takes /model Sonnet and /effort HIGH
  if (run.command === "model" && arg && run.said.startsWith("Set model to")) await keep(session, { model: arg });
  else if (run.command === "effort" && run.said.startsWith("Set effort level to")) await keep(session, { effort: arg as Effort });
  else if (run.command === "effort" && run.said.startsWith("Effort level set to auto")) await save(session, { ...pickOf(session), effort: undefined });
}

// Claude Code's own default, as the user's settings name it.
function claudeDefault(): Pick {
  try {
    const s = JSON.parse(readFileSync(join(HOME, ".claude", "settings.json"), "utf8"));
    return { model: typeof s.model === "string" ? s.model : undefined, effort: EFFORTS.includes(s.effortLevel) ? s.effortLevel : undefined };
  } catch {
    return {};
  }
}

export function shown(session: string, chat: boolean): Shown {
  const s = settings.load();
  const base: Pick = chat ? { model: s.chat_model, effort: s.chat_effort } : claudeDefault();
  const { model = "default", effort = "" } = { ...base, ...pickOf(session) };
  const takes = entryOf(model)?.supportedEffortLevels; // none for a model without effort levels, such as Haiku
  return { model, name: nameOf(model), effort: list && !takes?.length ? "" : effort };
}

// Pick the session's model or effort. A session the host holds takes it from its next request, the turn running now
// included; one it does not takes it when the host starts it again.
export async function change(session: string, pick: Pick): Promise<void> {
  if (pick.model !== undefined && !(await all()).some((m) => m.value === pick.model)) throw new Error(`Claude Code has no model ${pick.model}.`);
  if (pick.effort !== undefined && !EFFORTS.includes(pick.effort)) throw new Error(`Effort is one of ${EFFORTS.join(", ")}.`);
  await keep(session, pick);
  const row = await hosted.holds(session);
  if (!row) return;
  try {
    await hosted.settings(session, pick);
  } catch {
    // A host of older code has no such call: an idle session is closed, and its next message starts it again with the
    // pick. One at work keeps its model until then.
    if (!row.working && !row.asks) await hosted.close(session).catch(() => {});
  }
}

// --- what Claude Code said -------------------------------------------------------------------------------------------
// The chip's menu opens at once, with what desk last heard (the user, 20 Oct: "make sure they don't take seconds to
// press that button", and "the number of usage flipping won't be much, so it needs not to be exact. we prioritize
// speed here"). The models, the plan's usage and each session's context are kept in the heard table, and asked again
// only in the background, never while the menu waits: on 20 Oct the usage, asked on every open a minute after the last,
// held the menu up 2 to 4 s while a Claude Code started only for it.

const heard = new Map<string, { value: any; at: number }>(); // at in ms

async function hear(name: string, value: unknown) {
  const at = Date.now();
  heard.set(name, { value, at });
  await db.write((tx) => tx.query("insert into heard values ($1, $2, $3) on conflict (name) do update set value = excluded.value, at = excluded.at",
    [name, JSON.stringify(value), at / 1000]));
}

async function ask<T>(question: (q: Query) => Promise<T>): Promise<T> {
  const claude = which("claude");
  if (!claude) throw new Error("No claude on desk's PATH.");
  let wake = () => {};
  const silent = (async function* (): AsyncGenerator<SDKUserMessage> {
    await new Promise<void>((r) => (wake = r));
  })();
  const q = query({ prompt: silent, options: { cwd: HOME, persistSession: false, settingSources: [], pathToClaudeCodeExecutable: claude,
    env: { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: "desk" } } });
  try {
    return await question(q);
  } finally {
    q.close();
    wake();
  }
}

// --- the models ------------------------------------------------------------------------------------------------------
// Claude Code's list changes only with Claude Code: desk keeps the one its version said, and lists again when the
// version changes, as an update leaves it.

let list: ModelInfo[] | null = null;
let listedBy = ""; // the version of Claude Code that said the list
let listing: Promise<ModelInfo[]> | null = null;
let looked = 0; // ms, when desk last looked at Claude Code's version
const LOOK = 10 * 60_000; // ms between looks, each a `claude --version`, which answers in milliseconds

async function version(): Promise<string> {
  const claude = which("claude");
  if (!claude) return "";
  const ran = await run([claude, "--version"], { timeout: 10 });
  return ran.code ? "" : ran.stdout.trim();
}

function relist(): Promise<ModelInfo[]> {
  listing ??= (async () => {
    const by = await version();
    if (list && by === listedBy) return list;
    const found = await ask((q) => q.supportedModels());
    [list, listedBy] = [found, by];
    await hear("models", { version: by, models: found });
    return found;
  })().finally(() => (listing = null));
  return listing;
}

// The list as kept, at once; only a desk that never heard one waits for it, once.
async function all(): Promise<ModelInfo[]> {
  if (Date.now() - looked > LOOK) {
    looked = Date.now();
    void relist().catch((error) => console.error("desk: listing Claude Code's models", error));
  }
  return list ?? relist();
}

const entryOf = (model: string) => list?.find((m) => m.value === model) ?? list?.find((m) => m.resolvedModel === model);

// The model's name, as Claude Code's /model lists it; an alias desk has not looked up yet shows as itself.
function nameOf(model: string): string {
  if (!list) {
    void all().catch(() => {});
    return model === "default" ? "Default" : model.charAt(0).toUpperCase() + model.slice(1);
  }
  const found = entryOf(model);
  if (found?.value === "default") return list.find((m) => m.value !== "default" && m.resolvedModel === found.resolvedModel)?.displayName ?? found.displayName;
  return found?.displayName ?? model;
}

// The menu's models: the newest of each family, Opus, Fable, Sonnet and Haiku, as Claude Code lists them newest first.
export async function menu(): Promise<Model[]> {
  const families = new Set<string>();
  return (await all()).filter((m) => m.value !== "default" && !families.has(m.displayName.split(" ")[0]) && families.add(m.displayName.split(" ")[0]))
    .map((m) => ({ value: m.value, name: m.displayName, efforts: m.supportedEffortLevels ?? [] }));
}

// --- the usage -------------------------------------------------------------------------------------------------------
// Every reply of a session says the plan's usage, in Claude Code's rate-limit event, which the host passes on (turns.ts,
// heardUsage). desk asks Claude Code itself only once no session has said it for a while, as when none works.

export interface Window {
  percent: number;
  resets: string | null; // ISO 8601; null once the window reset, until desk hears when it next does
}

export interface Usage {
  five_hour: Window | null;
  seven_day: Window | null;
}

const STALE = 15 * 60_000; // ms with no word of the usage, after which desk asks Claude Code in the background
const RETRY = 60_000; // ms after an ask before the next, so a failing one is not started on every open
let usageAsked = 0;

// How much of the plan's 5-hour and weekly limits is used, as last heard; none for an API key, which has no plan
// limits, or before desk heard any. A window whose reset passed since is unused.
export function used(): Usage {
  const kept = heard.get("usage");
  if ((!kept || Date.now() - kept.at > STALE) && Date.now() - usageAsked > RETRY) {
    usageAsked = Date.now();
    const window = (w?: { utilization: number | null; resets_at: string | null } | null): Window | null =>
      w && w.utilization !== null && w.resets_at ? { percent: Math.round(w.utilization), resets: w.resets_at } : null;
    void ask((q) => q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }))
      .then((u) => hear("usage", { five_hour: window(u.rate_limits?.five_hour), seven_day: window(u.rate_limits?.seven_day) }))
      .catch((error) => console.error("desk: asking Claude Code the usage", error));
  }
  const now = (w?: Window | null): Window | null => (!w ? null : w.resets && Date.parse(w.resets) > Date.now() ? w : { percent: 0, resets: null });
  return { five_hour: now(kept?.value.five_hour), seven_day: now(kept?.value.seven_day) };
}

// A session's reply said the usage: its rate-limit event's unifiedWindows, which the SDK's types do not name yet, with
// each window's utilization from 0 to 1. Written down only when a number moved.
function heardUsage(windows: Record<string, { utilization?: number; resetsAt?: number } | undefined>) {
  const window = (w?: { utilization?: number; resetsAt?: number }): Window | null =>
    w && typeof w.utilization === "number" && w.resetsAt ? { percent: Math.round(w.utilization * 100), resets: new Date(w.resetsAt * 1000).toISOString() } : null;
  const said: Usage = { five_hour: window(windows?.five_hour), seven_day: window(windows?.seven_day) };
  if (!said.five_hour && !said.seven_day) return;
  const kept = heard.get("usage"), same = (a?: Window | null, b?: Window | null) => a?.percent === b?.percent && a?.resets === b?.resets;
  if (kept && same(kept.value.five_hour, said.five_hour) && same(kept.value.seven_day, said.seven_day)) kept.at = Date.now();
  else void hear("usage", said).catch((error) => console.error("desk: keeping the usage", error));
}

// --- the context -----------------------------------------------------------------------------------------------------
// How full each session's context is, as the host counts it (/context's count): asked after each turn ends, and kept,
// so the menu shows it at once, even for a session whose process has gone.

export interface Context {
  tokens: number;
  max: number;
  percent: number;
}

const counting = new Set<string>();

function recount(session: string) {
  if (counting.has(session)) return;
  counting.add(session);
  void hosted.context(session).then((c) => hear(`context:${session}`, c))
    .catch(() => {}) // no process holds it, so nothing changed since the last count
    .finally(() => counting.delete(session));
}

// The session's context as last counted, or null before any count; counted again in the background when a turn ran
// since, or runs now.
export function context(session: string): Context | null {
  const kept = heard.get(`context:${session}`), ended = turns.ended(session);
  if (!kept || turns.working(session) || (ended !== null && ended * 1000 > kept.at)) recount(session);
  return kept?.value ?? null;
}

// --- start ----------------------------------------------------------------------------------------------------------

// What desk last heard, as it starts, then the host's word of each turn's end and each reply's usage.
async function listen() {
  const rows = (await sql().query<{ name: string; value: unknown; at: number }>("select name, value, at from heard")).rows;
  for (const r of rows) heard.set(r.name, { value: r.value, at: r.at * 1000 });
  const models = heard.get("models")?.value as { version: string; models: ModelInfo[] } | undefined;
  if (models) [list, listedBy] = [models.models, models.version];
  void all().catch(() => {}); // looks at Claude Code's version now
  turns.onChange((_sessions, ended) => { for (const session of ended) recount(session); });
  turns.onUsage(heardUsage);
}
