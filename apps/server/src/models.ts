// The model and effort each session runs on, which the composer's chip shows and changes, and the account's usage,
// which the chip's menu shows. A session's pick is kept in DATA_DIR/session-models.json, by session id, so it holds
// when the host starts the session again; a session with no pick runs as it started: a desk chat on Settings >
// Preferences (settings.ts), any other on Claude Code's own default (~/.claude/settings.json).
//
// The list of models and the usage come from Claude Code itself, asked by one started only for the question (as the
// SDK's supportedModels and the call behind /usage), with no message, no settings and no transcript, so it costs
// nothing and leaves no trace. desk asks it here rather than in the session host, which may still run older code.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { query, type ModelInfo, type Query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { DATA_DIR, HOME } from "./config.ts";
import * as hosted from "./hosted.ts";
import { which } from "./proc.ts";
import * as settings from "./settings.ts";
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

const FILE = join(DATA_DIR, "session-models.json");

function picks(): Record<string, Pick> {
  try {
    return existsSync(FILE) ? JSON.parse(readFileSync(FILE, "utf8")) : {};
  } catch {
    return {}; // a file broken by hand counts as none
  }
}

export const pickOf = (session: string): Pick => picks()[session] ?? {};

export function keep(session: string, pick: Pick) {
  const all = picks();
  all[session] = { ...all[session], ...pick };
  writeFileSync(FILE, `${JSON.stringify(all, null, 2)}\n`, "utf8");
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
  keep(session, pick);
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

// --- asking Claude Code ----------------------------------------------------------------------------------------------

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

let list: ModelInfo[] | null = null; // asked once a run of desk: it changes only with Claude Code
let asking: Promise<ModelInfo[]> | null = null;

async function all(): Promise<ModelInfo[]> {
  if (list) return list;
  asking ??= ask((q) => q.supportedModels()).then((found) => (list = found)).finally(() => (asking = null));
  return asking;
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

export interface Window {
  percent: number;
  resets: string; // ISO 8601
}

export interface Usage {
  five_hour: Window | null;
  seven_day: Window | null;
}

const FRESH = 60_000; // ms the numbers are kept before Claude Code is asked again
let usage: [number, Promise<Usage>] | null = null;

// How much of the plan's 5-hour and weekly limits is used; none for an API key, which has no plan limits.
export function used(): Promise<Usage> {
  if (!usage || Date.now() - usage[0] > FRESH) {
    const window = (w?: { utilization: number | null; resets_at: string | null } | null): Window | null =>
      w && w.utilization !== null && w.resets_at ? { percent: Math.round(w.utilization), resets: w.resets_at } : null;
    const asked = ask((q) => q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }))
      .then((u) => ({ five_hour: window(u.rate_limits?.five_hour), seven_day: window(u.rate_limits?.seven_day) }));
    asked.catch(() => { if (usage?.[1] === asked) usage = null; });
    usage = [Date.now(), asked];
  }
  return usage[1];
}
