// The user's Gmail, read each minute, each mail written as a notice for the firewall to judge (notices.ts; the desk
// issue "desk as my notification center", 2 Nov: "desk will have connectors. and it'll receive all noti from all
// platforms. at least for now to me is slack and email only").
//
// It reads Gmail as muse's bin/mail-daily does, with the same OAuth client, `pass show mail/gmail-muse`: every mail
// that came since the newest one written, in the inbox, Trash or Spam, except the user's own. Each mail is written,
// the ordinary ones too, unjudged: the firewall judges it once, against the secretary's ordinary topics, and
// bin/mail-daily reads those verdicts at 08:00 rather than judging again. A mail's text in a notice is its subject and
// Gmail's snippet, the start of its text, as bin/mail-daily's judge gets.
//
// Gmail lists a mail by its search a little after it arrives, so each poll reads OVERLAP back from the newest mail
// written, and fetches only the ids not written yet. The first poll, with no mail written, reads FIRST back, as
// bin/mail-daily's first run does; a desk that was down reads from where it stopped.
//
// Nothing here logs or keeps the OAuth client, its refresh token or an access token outside this process's memory,
// nor a mail's text outside the notices table.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as notices from "./notices.ts";

const API = "https://gmail.googleapis.com/gmail/v1/users/me/";
const EVERY = 60_000;
const OVERLAP = 10 * 60; // seconds
const FIRST = 24 * 3600; // seconds
const QUERY = "-in:sent -from:me";
// Marketing mail pads its preview text with these, as bin/mail-daily's INVISIBLE says.
const INVISIBLE = /[­͏​-‏⁠﻿]/g;

let access: { token: string; until: number } | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let stopped = false;
let said = ""; // the last error logged, so that one that repeats each minute is logged once

// Gmail refused the login: the refresh token was revoked or expired, so a poll can do nothing until it is renewed.
export class SignedOut extends Error {}

async function token(): Promise<string> {
  if (access && Date.now() < access.until) return access.token;
  const { stdout } = await promisify(execFile)("pass", ["show", "mail/gmail-muse"], { timeout: 30_000 });
  const c = JSON.parse(stdout);
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    body: new URLSearchParams({ grant_type: "refresh_token", client_id: c.client_id, client_secret: c.client_secret, refresh_token: c.refresh_token }),
    signal: AbortSignal.timeout(60_000),
  });
  const body = (await r.json().catch(() => ({}))) as Record<string, any>;
  if (body.error === "invalid_grant") throw new SignedOut("Gmail refused the login (invalid_grant)");
  if (!r.ok || !body.access_token) throw new Error(`Gmail's token endpoint answered ${r.status}`);
  access = { token: body.access_token, until: Date.now() + (Number(body.expires_in ?? 3600) - 300) * 1000 };
  return access.token;
}

async function call(path: string, params: Record<string, string | string[]>): Promise<Record<string, any>> {
  const query = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) for (const one of [v].flat()) query.append(k, one);
  for (let tries = 0; ; tries++) {
    const r = await fetch(`${API}${path}?${query}`, { headers: { authorization: `Bearer ${await token()}` }, signal: AbortSignal.timeout(60_000) });
    if (r.status === 401 && tries === 0) {
      access = null; // taken back before its time: ask for another once
      continue;
    }
    if (!r.ok) throw new Error(`Gmail answered ${r.status} on ${path.split("/")[0]}`);
    return (await r.json()) as Record<string, any>;
  }
}

// The ids of the mail matching a search, Trash and Spam included.
async function ids(q: string): Promise<string[]> {
  const out: string[] = [];
  let page: string | undefined;
  do {
    const r = await call("messages", { q, maxResults: "500", includeSpamTrash: "true", ...(page ? { pageToken: page } : {}) });
    out.push(...(r.messages ?? []).map((m: { id: string }) => m.id));
    page = r.nextPageToken;
  } while (page);
  return out;
}

// "Name <addr@x>" as its name, or its address when it has none.
function sender(from: string) {
  const m = from.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>/);
  return (m?.[1].trim() || m?.[2] || from).trim() || "someone";
}

const where = (labels: string[]) => (labels.includes("SPAM") ? "spam" : labels.includes("TRASH") ? "trash" : labels.includes("INBOX") ? "inbox" : "all");

async function notice(id: string): Promise<notices.Notice> {
  const m = await call(`messages/${id}`, { format: "metadata", metadataHeaders: ["From", "Subject"] });
  const h = Object.fromEntries((m.payload?.headers ?? []).map((x: { name: string; value: string }) => [x.name.toLowerCase(), x.value]));
  const labels: string[] = m.labelIds ?? [];
  const snippet = String(m.snippet ?? "").replace(INVISIBLE, "").replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
  return {
    id: `mail:${id}`,
    source: "mail",
    thread: `mail:${m.threadId}`,
    place: labels.includes("SPAM") ? "mail, in Spam" : "mail",
    who: sender(h.from ?? ""),
    text: `${h.subject || "(no subject)"}\n${snippet}`,
    link: `https://mail.google.com/mail/u/0/#${where(labels)}/${id}`,
    at: Math.floor(Number(m.internalDate) / 1000),
    verdict: null,
    why: "",
  };
}

// ---- A thread, whole

const LONG = 6000; // characters of a mail's text a chat gets

// A mail's text: its text/plain part, else its HTML's words, quoted replies left in, as the user would scroll them.
function bodyOf(part: Record<string, any> | undefined): string {
  if (!part) return "";
  const decode = (data: string) => Buffer.from(data, "base64url").toString("utf8");
  const find = (p: Record<string, any>, type: string): string | null =>
    p.mimeType === type && p.body?.data ? decode(p.body.data) : (p.parts ?? []).map((q: Record<string, any>) => find(q, type)).find((t: string | null) => t) ?? null;
  const text = find(part, "text/plain");
  if (text) return text;
  const html = find(part, "text/html") ?? "";
  return html.replace(/<(style|script)[\s\S]*?<\/\1>/gi, "").replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, "\n").replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

// A mail thread as Gmail holds it now, for a chat on its Inbox row (threads.ts): each mail, the user's own too, as
// "you", oldest first, its subject over its text, cut at LONG characters.
export async function thread(id: string): Promise<{ who: string; at: number; text: string }[]> {
  const t = await call(`threads/${id.slice("mail:".length)}`, { format: "full" });
  return (t.messages ?? []).map((m: Record<string, any>) => {
    const h = Object.fromEntries((m.payload?.headers ?? []).map((x: { name: string; value: string }) => [x.name.toLowerCase(), x.value]));
    const text = bodyOf(m.payload).replace(INVISIBLE, "").replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").trim();
    return {
      who: (m.labelIds ?? []).includes("SENT") ? "you" : sender(h.from ?? ""),
      at: Math.floor(Number(m.internalDate) / 1000),
      text: `${h.subject || "(no subject)"}\n${text.length > LONG ? `${text.slice(0, LONG)}…` : text}`,
    };
  });
}

// One poll: the mail that came since the newest written, each new one written as a notice. Returns the ones written.
export async function poll(): Promise<notices.Notice[]> {
  const now = Math.floor(Date.now() / 1000);
  const newest = await notices.newest("mail");
  const since = newest == null ? now - FIRST : Math.max(newest - OVERLAP, now - FIRST * 7);
  const found = await ids(`after:${since} ${QUERY}`);
  const known = await notices.known(found.map((id) => `mail:${id}`));
  const written: notices.Notice[] = [];
  // Oldest first, as Gmail lists the newest first, so that a poll cut short leaves the newest for the next
  for (const id of found.filter((id) => !known.has(`mail:${id}`)).reverse()) {
    const n = await notice(id);
    if (await notices.add(n)) written.push(n);
  }
  return written;
}

export function start() {
  console.log("mail: reading Gmail each minute");
  const tick = async () => {
    try {
      const written = await poll();
      if (written.length) console.log(`mail: ${written.length} new`);
      said = "";
    } catch (e) {
      const message = (e as Error).message;
      if (message !== said) console.error(`mail: ${message}`);
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
