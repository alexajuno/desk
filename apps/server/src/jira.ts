// A Jira ticket a chat follows, read each minute, each change written as a notice for that chat (notices.ts, wakes.ts):
// "jira should be bounded the same way as slack: on changes on ticket design, wakes the chat up and update code" (the
// user, 9 Nov; the desk issue "Follow a Jira ticket like a Slack thread"). A ticket is a thread, jira:<KEY>, attached to
// a chat as a Slack or mail thread is (threads.ts, idOf). Jira Cloud pushes only to a public address and needs an admin,
// and desk runs on localhost, so desk polls ("polling is valid", the user, 9 Nov).
//
// It asks Jira about the followed tickets only: one search for when each was last updated, then the whole ticket, with
// its changelog, for those that moved since desk last looked. A change counts when it is the description (which holds the
// acceptance criteria: no field of its own on IGH), the summary, the status, or a comment, new or edited. Every author's
// counts, the user's too, since they edit a ticket in Jira's page, not in desk, and desk posts nothing there. A
// description's notice holds the lines that went and the lines that came, so the chat sees what moved.
//
// What desk last looked at, per ticket, is kept in meta, so that a restart or a stop catches what changed meanwhile, and
// a ticket just attached starts from the moment desk first saw it, not from its history.
//
// The login is the user's Atlassian API token, `pass show dev/atlassian-api-token`, as muse's jira skill; nothing here
// logs or keeps it outside this process's memory, nor a ticket's text outside the notices table.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { sql } from "./db.ts";
import * as notices from "./notices.ts";

const SITE = "https://ownego.atlassian.net";
const API = `${SITE}/rest/api/2`;
const EMAIL = "giolynx104@gmail.com";
const EVERY = 60_000;
const OVERLAP = 5; // seconds read back from the last look, as Jira's clock and ours differ a little
const LONG = 3000; // characters of one change a chat gets
export const KEY = /^[A-Z][A-Z0-9]+-\d+$/;

let auth: string | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let stopped = false;
let said = ""; // the last error logged, so that one that repeats each minute is logged once

async function login(): Promise<string> {
  if (auth) return auth;
  const { stdout } = await promisify(execFile)("pass", ["show", "dev/atlassian-api-token"], { timeout: 30_000 });
  auth = `Basic ${Buffer.from(`${EMAIL}:${stdout.trim()}`).toString("base64")}`;
  return auth;
}

async function call(path: string, params: Record<string, string>): Promise<Record<string, any>> {
  for (let tries = 0; ; tries++) {
    const r = await fetch(`${API}/${path}?${new URLSearchParams(params)}`, { headers: { authorization: await login(), accept: "application/json" }, signal: AbortSignal.timeout(60_000) });
    if (r.status === 401 && tries === 0) {
      auth = null; // the token may have been renewed: read it again once
      continue;
    }
    if (!r.ok) throw new Error(`Jira answered ${r.status} on ${path.split("/").slice(0, 2).join("/").replace(/-\d+$/, "-…")}`);
    return (await r.json()) as Record<string, any>;
  }
}

// ---- What changed

const seconds = (iso: string) => Math.floor(Date.parse(iso) / 1000);
const clip = (s: string) => (s.length > LONG ? `${s.slice(0, LONG)}…` : s);

// The lines of a description that went and those that came, "- " and "+ ", in the order they stand: not a minimal diff,
// but enough to see what moved. Lines that only moved place are left out.
export function lineDiff(before: string, after: string): string {
  const count = (lines: string[]) => lines.reduce((m, l) => m.set(l, (m.get(l) ?? 0) + 1), new Map<string, number>());
  const a = before.split("\n"), b = after.split("\n"), inA = count(a), inB = count(b);
  const out: string[] = [];
  for (const l of a) {
    if ((inB.get(l) ?? 0) > 0) inB.set(l, inB.get(l)! - 1);
    else if (l.trim()) out.push(`- ${l}`);
  }
  for (const l of b) {
    if ((inA.get(l) ?? 0) > 0) inA.set(l, inA.get(l)! - 1);
    else if (l.trim()) out.push(`+ ${l}`);
  }
  // The "-" lines were collected against the new text, the "+" against the old, so both are right whatever the order
  return out.length ? out.join("\n") : "(only blank lines or the order of lines changed)";
}

type Change = Omit<notices.Notice, "verdict" | "why">;

export function changesOf(key: string, ticket: Record<string, any>, since: number): Change[] {
  const link = `${SITE}/browse/${key}`, thread = `jira:${key}`, out: Change[] = [];
  const base = { source: "jira" as const, thread, place: key, link };
  for (const h of (ticket.changelog?.histories ?? []) as Record<string, any>[]) {
    const at = seconds(h.created);
    if (at <= since) continue;
    const who = h.author?.displayName ?? "someone";
    for (const item of h.items as { field: string; fromString?: string; toString?: string }[]) {
      if (item.field === "description") {
        out.push({ ...base, id: `jira:${key}:h${h.id}:description`, who, at,
          text: `edited the description\n${clip(lineDiff(item.fromString ?? "", item.toString ?? ""))}` });
      } else if (item.field === "summary") {
        out.push({ ...base, id: `jira:${key}:h${h.id}:summary`, who, at, text: `renamed the ticket\n- ${item.fromString}\n+ ${item.toString}` });
      } else if (item.field === "status") {
        out.push({ ...base, id: `jira:${key}:h${h.id}:status`, who, at, text: `moved it from ${item.fromString} to ${item.toString}` });
      }
    }
  }
  for (const c of (ticket.fields?.comment?.comments ?? []) as Record<string, any>[]) {
    const made = seconds(c.created), edited = seconds(c.updated);
    if (edited <= since) continue;
    // An edited comment is a notice of its own, by when it was edited
    const was = edited > made + 1;
    out.push({ ...base, id: `jira:${key}:c${c.id}:${edited}`, who: c.author?.displayName ?? "someone", at: was ? edited : made,
      link: `${link}?focusedCommentId=${c.id}`, text: `${was ? "edited a comment" : "commented"}\n${clip(String(c.body ?? "").trim())}` });
  }
  return out.sort((x, y) => x.at - y.at);
}

// ---- A ticket, whole

// Whether a ticket exists and the token can read it, for attaching it to a chat (threads.ts, idOf).
export async function exists(key: string): Promise<boolean> {
  try {
    await call(`issue/${key}`, { fields: "summary" });
    return true;
  } catch (e) {
    if (/answered 40[04]/.test((e as Error).message)) return false;
    throw e;
  }
}

// A ticket as it stands, for a chat on it (threads.ts, whole): its title, status and description as the first message,
// from its reporter, then each comment, oldest first, cut at LONG characters.
export async function thread(id: string): Promise<{ who: string; at: number; text: string }[]> {
  const key = id.slice("jira:".length);
  const t = await call(`issue/${key}`, { fields: "summary,status,description,comment,reporter,created" });
  const f = t.fields;
  return [
    { who: f.reporter?.displayName ?? "someone", at: seconds(f.created),
      text: `${key} ${f.summary} (${f.status?.name ?? "no status"})\n${clip(String(f.description ?? "(no description)").trim())}` },
    ...((f.comment?.comments ?? []) as Record<string, any>[]).map((c) => ({ who: c.author?.displayName ?? "someone", at: seconds(c.updated), text: clip(String(c.body ?? "").trim()) })),
  ];
}

// ---- A poll

const meta = (key: string) => `jira since ${key}`;

async function seenAt(key: string): Promise<number | null> {
  const r = await sql().query<{ value: string }>("select value from meta where name = $1", [meta(key)]);
  return r.rows[0] ? Number(r.rows[0].value) : null;
}

async function remember(key: string, at: number) {
  await sql().query("insert into meta values ($1, $2) on conflict (name) do update set value = excluded.value", [meta(key), String(at)]);
}

// The tickets followed now, as thread ids; set by server.ts, so that this file reads no chat.
let followed: () => Promise<string[]> = async () => [];
export const followWith = (fn: typeof followed) => { followed = fn; };

// When each of these tickets was last updated. One search; but Jira refuses all of them when one key does not exist, so
// then each is asked alone and the missing one is logged once, not retried in silence.
type Updated = { key: string; fields: { updated: string } };
const missing = new Set<string>();
async function updatedOf(keys: string[]): Promise<Updated[]> {
  const ask = async (list: string[]) => ((await call("search/jql", { jql: `key in (${list.join(",")})`, fields: "updated", maxResults: String(list.length) })).issues ?? []) as Updated[];
  try {
    return await ask(keys);
  } catch (e) {
    if (!/answered 400/.test((e as Error).message) || keys.length === 1) throw e;
  }
  const out: Updated[] = [];
  for (const k of keys) {
    try {
      out.push(...(await ask([k])));
    } catch (e) {
      if (!missing.has(k)) console.error(`jira: ${k} cannot be read, ${(e as Error).message}`);
      missing.add(k);
    }
  }
  return out;
}

// One poll: the followed tickets that moved since desk last looked, each change written as a notice. Returns the ones
// written. A ticket desk cannot read (a key that does not exist, a project the token lacks) is logged once and left.
export async function poll(): Promise<notices.Notice[]> {
  const keys = (await followed()).map((t) => t.slice("jira:".length)).filter((k) => KEY.test(k));
  if (!keys.length) return [];
  const started = Math.floor(Date.now() / 1000);
  const written: notices.Notice[] = [];
  for (const issue of await updatedOf(keys)) {
    const before = await seenAt(issue.key);
    if (before === null) {
      await remember(issue.key, started); // just attached: from now on
      continue;
    }
    if (seconds(issue.fields.updated) <= before - OVERLAP) continue;
    const ticket = await call(`issue/${issue.key}`, { fields: "summary,status,description,comment", expand: "changelog" });
    for (const change of changesOf(issue.key, ticket, before - OVERLAP)) {
      const n = { ...change, verdict: null, why: "" } as notices.Notice;
      if (await notices.add(n)) written.push(n);
    }
    await remember(issue.key, started);
  }
  return written;
}

export function start() {
  console.log("jira: reading the followed tickets each minute");
  const tick = async () => {
    try {
      const written = await poll();
      if (written.length) console.log(`jira: ${written.length} new`);
      said = "";
    } catch (e) {
      const message = (e as Error).message;
      if (message !== said) console.error(`jira: ${message}`);
      said = message;
    }
    if (!stopped) timer = setTimeout(tick, EVERY);
  };
  void tick();
}

export function stop() {
  stopped = true;
  if (timer) clearTimeout(timer);
}
