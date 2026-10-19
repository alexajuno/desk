// Automations: an agent run that a trigger starts, whose first reply reaches the user in the Inbox, as bin/jobs's daily
// list does. "a claude's session on fixed schedule" / "auto trigger on certain condition. and i wanna hear the report"
// (the user, 19 Oct; the plan is a file of the issue "Automations: Claude runs on a schedule or a condition").
//
// Each is a file, automations/<slug>.md in DESK_DATA: front matter, then what it does, which the run's agent is given.
//
//     ---
//     title: Jobs worth a look
//     when: every day 08:00
//     check: ~/projects/muse/bin/jobs
//     agent: jobs
//     ---
//     Tell me which of the morning's jobs are worth a look.
//
// Two triggers. `when`, a time on desk's clock: when it comes, desk runs `check` first, if there is one, and an empty
// output skips the run, so "every 15 min, if there is new mail" is a time and a check. Or a call, POST
// /api/automations/<slug>/run, from a script or the page's Run now. A run is a chat with the agent (or a bare Claude
// chat, with none), named after the automation; it starts on the description and what the check printed.
//
// The file is the record, and is read each time it is needed: a dozen small files. Postgres keeps only what happened:
// when desk first saw each one, when it last fired, its last run's chat and how its last check went.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AUTOMATIONS_DIR, HOME } from "./config.ts";
import * as chats from "./chats.ts";
import { sql } from "./db.ts";
import { asText, dump, split } from "./frontmatter.ts";
import { now } from "./issues.ts";
import { run, Timeout } from "./proc.ts";
import * as roster from "./roster.ts";
import { parseLocal } from "./when.ts";

export const STATES = ["active", "paused"];

export interface Automation {
  slug: string;
  title: string;
  when: string; // empty: it runs on calls only
  check: string; // a shell command, run from the home folder
  agent: string; // one of ~/.claude/agents, or empty for a bare Claude chat
  state: string;
  body: string;
}

const FIELDS = ["title", "when", "check", "agent", "state"] as const;

export const file = (slug: string) => join(AUTOMATIONS_DIR, `${slug}.md`);

export function parse(slug: string, text: string): Automation {
  const { meta, body } = split(text);
  const a: Automation = { slug, title: slug, when: "", check: "", agent: "", state: "active", body: body.trim() };
  for (const name of FIELDS) if (meta[name] !== undefined && meta[name] !== null) a[name] = asText(meta[name]).trim();
  return a;
}

export function render(a: Automation): string {
  const meta: Record<string, string> = {};
  for (const name of FIELDS) if (a[name]) meta[name] = a[name];
  return `---\n${dump(meta)}\n---\n\n${a.body.trim()}\n`;
}

const slugs = () => (existsSync(AUTOMATIONS_DIR) ? readdirSync(AUTOMATIONS_DIR).filter((n) => n.endsWith(".md")).map((n) => n.slice(0, -3)) : []);

export const exists = (slug: string) => /^[\w-]+$/.test(slug) && existsSync(file(slug));

export const load = (slug: string) => parse(slug, readFileSync(file(slug), "utf8"));

// Every automation, the active ones first, then by title.
export const loadAll = () => slugs().map(load).sort((a, b) => Number(a.state !== "active") - Number(b.state !== "active") || a.title.localeCompare(b.title));

let version = 0; // moves on every save and every firing, for stamp()

export function save(a: Automation) {
  mkdirSync(AUTOMATIONS_DIR, { recursive: true });
  writeFileSync(file(a.slug), render(a), "utf8");
  version++;
}

export async function remove(slug: string) {
  unlinkSync(file(slug));
  await sql().query("delete from automations where slug = $1", [slug]);
  version++;
}

export function newSlug(title: string): string {
  const base = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50) || "automation";
  let slug = base, n = 2;
  while (existsSync(file(slug))) slug = `${base}-${n++}`;
  return slug;
}

// What the pages show changed: a file written, by desk or by hand, or a firing. The frame carries it, and a page of
// automations fetches itself again when it moves.
export const stamp = () => `${version}:${slugs().map((s) => `${s}@${statSync(file(s)).mtimeMs}`).join(",")}`;

// --- when ------------------------------------------------------------------------------------------------------------
// A few plain phrases, which the page shows as they are written:
//
//     every 15 min     every 2 hours     every hour
//     every day 08:00     every day 08:00, 20:00     every weekday 08:00     every sunday 20:00     every mon, thu 09:30

export type Schedule = { every: number } | { days: number[]; times: number[] }; // ms apart; or weekdays (0 is Sunday) and minutes into the day

const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const DAY_SETS: Record<string, number[]> = { day: [0, 1, 2, 3, 4, 5, 6], weekday: [1, 2, 3, 4, 5], weekend: [0, 6] };

export class BadWhen extends Error {}

export function schedule(when: string): Schedule | null {
  const w = when.trim().toLowerCase().replace(/\s+/g, " ");
  if (!w) return null;
  const every = /^every (?:(\d+) )?(min|mins|minute|minutes|hour|hours)$/.exec(w);
  if (every) {
    const n = Number(every[1] ?? 1);
    if (n < 1) throw new BadWhen(`"${when}" never comes round.`);
    return { every: n * (every[2].startsWith("hour") ? 3_600_000 : 60_000) };
  }
  const at = /^every (.+?) (?:at )?(\d{1,2}:\d{2}(?:(?:, ?| and )\d{1,2}:\d{2})*)$/.exec(w);
  if (!at) throw new BadWhen(`desk can't read "${when}". Write it as "every 15 min", "every hour", "every day 08:00", "every weekday 08:00" or "every sunday 20:00".`);
  const days = new Set<number>();
  for (const name of at[1].split(/, ?| and /)) {
    const day = name.length >= 3 ? DAYS.findIndex((d) => d.startsWith(name)) : -1; // "sun", "sunday"
    const set = DAY_SETS[name] ?? (day >= 0 ? [day] : null);
    if (!set) throw new BadWhen(`"${name}" in "${when}" is no day desk knows.`);
    for (const d of set) days.add(d);
  }
  const times = at[2].split(/, ?| and /).map((t) => {
    const [h, m] = t.split(":").map(Number);
    if (h > 23 || m > 59) throw new BadWhen(`"${t}" in "${when}" is no time of day.`);
    return h * 60 + m;
  });
  return { days: [...days].sort((a, b) => a - b), times: times.sort((a, b) => a - b) };
}

// The moment of a time on the day of `day`, in local time.
const atMinute = (day: Date, minute: number) => new Date(day.getFullYear(), day.getMonth(), day.getDate(), Math.floor(minute / 60), minute % 60);

// The last time it was set to fire at or before `t`, for a schedule of days and times: within the week before.
function slotBefore(s: { days: number[]; times: number[] }, t: Date): Date | null {
  for (let back = 0; back <= 7; back++) {
    const day = new Date(t.getFullYear(), t.getMonth(), t.getDate() - back);
    if (!s.days.includes(day.getDay())) continue;
    for (const minute of [...s.times].reverse()) {
      const slot = atMinute(day, minute);
      if (slot <= t) return slot;
    }
  }
  return null;
}

// The next time it is set to fire after `last`, its last firing (or when desk first saw it). One time missed while desk
// was down or the laptop slept is caught up once, at the first tick after: never once per time missed.
export function nextAfter(s: Schedule, last: Date, t = new Date()): Date {
  if ("every" in s) return new Date(last.getTime() + s.every);
  const missed = slotBefore(s, t);
  if (missed && missed > last) return missed;
  for (let ahead = 0; ahead <= 7; ahead++) {
    const day = new Date(t.getFullYear(), t.getMonth(), t.getDate() + ahead);
    if (!s.days.includes(day.getDay())) continue;
    for (const minute of s.times) {
      const slot = atMinute(day, minute);
      if (slot > t) return slot;
    }
  }
  throw new Error("A schedule of days and times always comes round within a week.");
}

// --- what happened ---------------------------------------------------------------------------------------------------

export interface State {
  seen: string; // when desk first saw it: a new one waits for its first time instead of firing at once
  fired: string | null; // when it last fired, by its clock or a call
  chat: string | null; // its last run's chat
  ran: string | null; // when that chat started
  note: string; // how the last firing went when it started no chat, such as a check that found nothing
}

export async function stateOf(slug: string): Promise<State> {
  const row = (await sql().query<State>("select seen, fired, chat, ran, note from automations where slug = $1", [slug])).rows[0];
  if (row) return row;
  const seen = now();
  await sql().query("insert into automations (slug, seen) values ($1, $2) on conflict do nothing", [slug, seen]);
  return { seen, fired: null, chat: null, ran: null, note: "" };
}

async function note(slug: string, fields: Partial<State>) {
  const names = Object.keys(fields) as (keyof State)[];
  await sql().query(`update automations set ${names.map((n, i) => `${n} = $${i + 2}`).join(", ")} where slug = $1`, [slug, ...names.map((n) => fields[n])]);
  version++;
}

// When it fires next by its clock, or null when it has none, is paused, or its `when` does not read.
export function next(a: Automation, st: State): Date | null {
  if (a.state !== "active") return null;
  try {
    const s = schedule(a.when);
    return s && nextAfter(s, parseLocal(st.fired ?? st.seen));
  } catch {
    return null;
  }
}

// What the API and the pages say of one: its fields, what happened, and what keeps it from running, if anything.
export async function asJson(a: Automation, full = false) {
  const st = await stateOf(a.slug), due = next(a, st);
  const chat = st.chat && chats.exists(st.chat) ? chats.load(st.chat) : null;
  let trouble = a.agent && !roster.find(a.agent) ? `No agent ${a.agent} in ~/.claude/agents.` : "";
  try {
    schedule(a.when);
  } catch (error) {
    trouble = (error as Error).message;
  }
  return { slug: a.slug, title: a.title, when: a.when, check: a.check, agent: a.agent, state: a.state, url: `/automation/${a.slug}`,
    next: due && now(due), fired: st.fired, note: st.note, trouble, last_run: chat && { chat: chat.id, session: chat.session, at: st.ran },
    ...(full ? { file: file(a.slug), body: a.body } : {}) };
}

// --- firing ----------------------------------------------------------------------------------------------------------

const CHECK_LIMIT = 300; // s: bin/jobs, the slowest script now on a timer, took 61 s on 19 Oct
const OUTPUT_LIMIT = 50_000; // characters of a check's output given to the agent, so a check that prints a log does not fill its context
const FAILED = "Its check failed"; // how every failing check's note starts
const firing = new Set<string>(); // slugs whose check runs now: a tick that comes meanwhile leaves them be

const lastLine = (text: string) => text.trim().split("\n").pop()?.slice(0, 200) ?? "";

// Run it now: its check, then, when the check printed something or a call sent a message, a chat with its agent.
// Answers how it went, in a few words.
export async function fire(a: Automation, why: string, message = ""): Promise<string> {
  if (firing.has(a.slug)) return "It is already running its check.";
  firing.add(a.slug);
  try {
    const st = await stateOf(a.slug);
    let output = "", failed = "";
    if (a.check) {
      try {
        const ran = await run(["sh", "-c", a.check], { cwd: HOME, timeout: CHECK_LIMIT });
        if (ran.code) failed = `${FAILED} with exit ${ran.code}: ${lastLine(ran.stderr || ran.stdout) || "no output"}`;
        output = ran.stdout.trim();
      } catch (error) {
        failed = error instanceof Timeout ? `${FAILED}: it ran past ${CHECK_LIMIT / 60} min and was stopped.` : `${FAILED} to start: ${(error as Error).message}`;
      }
      // A check that keeps failing is told once, by the first run it fails; the page says it after that.
      const told = st.note.startsWith(FAILED);
      if ((failed && told) || (!failed && !output && !message)) {
        const said = failed || "Its check found nothing.";
        await note(a.slug, { fired: now(), note: said });
        return said;
      }
    }
    const agent = a.agent ? roster.find(a.agent) : null;
    if (a.agent && !agent) {
      const said = `No agent ${a.agent} in ~/.claude/agents.`;
      await note(a.slug, { fired: now(), note: said });
      return said;
    }
    const chat = await chats.automationRun(agent, a.title, a.slug, runMessage(a, why, output, failed, message));
    await note(a.slug, { fired: now(), chat: chat.id, ran: now(), note: failed });
    return "Started a run.";
  } finally {
    firing.delete(a.slug);
  }
}

// The run's first message: what the automation does, and what its check and its call gave it. The panel shows it only as
// who sent it (transcript.ts, PUSH); the agent's reply is what the user reads.
function runMessage(a: Automation, why: string, output: string, failed: string, message: string): string {
  const parts = [a.body || `(${a.title} has no description: report what its check found.)`];
  if (failed) parts.push(`${failed}\nTell the user, so they can fix it; desk will not tell them again while it keeps failing.`);
  if (output) {
    const cut = output.length > OUTPUT_LIMIT ? `${output.slice(0, OUTPUT_LIMIT)}\n[desk cut the rest: ${output.length - OUTPUT_LIMIT} more characters]` : output;
    parts.push(`Its check, \`${a.check}\`, printed:\n\n${cut}`);
  }
  if (message) parts.push(`The call that started it said:\n\n${message}`);
  const who = `automation ${a.title.replace(/["<>\n]/g, " ").slice(0, 60)}`;
  return `<desk-push from="${who}">\n${parts.join("\n\n")}\n</desk-push>\n\ndesk ran the user's automation "${a.title}" ${why}. Do what it says, then ` +
    "report: your reply is the first thing the user reads, in desk's Inbox, and they may answer you there. Keep it brief: what matters, and what they need to do, if anything.";
}

// desk's clock for automations: once a minute, each active one whose time came fires. Off in a second desk for testing
// (DESK_CLOCK=0), which would otherwise run the user's automations twice.
const TICK = 60; // s

export function startClock() {
  const clock = async () => {
    try {
      await tick();
    } catch (error) {
      console.error("automations clock", error);
    }
    setTimeout(clock, TICK * 1000);
  };
  void clock();
}

async function tick() {
  for (const a of loadAll()) {
    if (firing.has(a.slug)) continue;
    const due = next(a, await stateOf(a.slug));
    if (due && due <= new Date()) void fire(a, `on its schedule, ${a.when}`).catch((error) => console.error(`automation ${a.slug}`, error));
  }
}
