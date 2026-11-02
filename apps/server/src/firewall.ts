// The firewall: what the connectors wrote unjudged, a work channel's message, an app's DM or a mail, judged by Claude
// once a minute as now (it pops up), later (it waits) or dropped (an ordinary mail, never shown). "a layer in desk handles
// noti filtering, that only when sth worth notified about that it pops up and carry it on with me" (the user, 2 Nov; the
// desk issue "desk as my notification center"). What a rule settles at the door, a DM or group DM from a person, an
// @mention and a reply in the user's thread, comes in as now already (slack.ts) and never reaches here.
//
// Mail is judged as muse's bin/mail-daily judges it, with the same ordinary topics, the secretary's
// (~/projects/muse/claude/agents/secretary.md, "## Ordinary topics"), read again on each call so that a topic the
// secretary adds holds at once: an ordinary mail is dropped, with its topic as why, and bin/mail-daily reads these
// verdicts at 08:00 (GET /api/mail/verdicts) rather than judging again. A Slack message is never dropped: it pops up or waits.
//
// One `claude -p` call judges all that came in the last minute, BATCH at most, on Sonnet with no tools, no settings and
// no session file, as bin/mail-daily's call. Its usage goes to muse's runs file as bin/usage_record.py writes it, since a
// run with no session file is counted from nothing else. A call that fails is tried again after a wait that doubles to
// half an hour, and the notices stay unjudged meanwhile. Nothing here logs a message's text.
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { HOME } from "./config.ts";
import * as notices from "./notices.ts";
import { run, which } from "./proc.ts";

const EVERY = 60_000;
const BATCH = 80; // notices per call, as bin/mail-daily's mails per call
const MODEL = "sonnet";
const EFFORT = "medium";
const TEXT = 1500; // characters of a Slack message the judge gets; a mail's subject and snippet are shorter
const SECRETARY = join(HOME, "projects/muse/claude/agents/secretary.md");
const RUNS = join(HOME, "projects/muse/log/raw/usage/runs"); // bin/usage_record.py's
const KEEP = ["subtype", "is_error", "duration_ms", "duration_api_ms", "num_turns", "session_id", "total_cost_usd", "usage", "modelUsage"];

const SCHEMA = {
  type: "object",
  properties: {
    notices: {
      type: "array",
      items: {
        type: "object",
        properties: { n: { type: "integer" }, verdict: { type: "string", enum: ["now", "later", "dropped"] }, why: { type: "string" } },
        required: ["n", "verdict", "why"],
      },
    },
  },
  required: ["notices"],
};

const JUDGE = `You are the firewall of the user's notifications. The user keeps neither Slack nor Gmail open, so as to keep \
their focus: what comes in from them reaches the user only through you. Decide for each notification below how it reaches them.

- "now": it pops up at once, breaking the user's focus. Only for what needs the user today and costs something if it \
waits until they next look: someone asks the user something or waits on them, a decision or a reply only they can give, \
production failing in a way someone must act on now with nobody on it yet, a deadline today, and in their job search an \
interview, a test, an offer or a step with a date.
- "later": it waits, unread, until the user looks: a Slack message in desk's Inbox, a mail in the morning report. \
Whatever is worth seeing but can wait.
- "dropped": for mail only: it fits one of the user's ordinary topics, below, and says nothing the topic's "Report it \
when" names. A Slack message is never dropped.

When torn between now and later, pick later: a pop-up costs the user's focus. When torn between later and dropped, pick \
later: a wrong line costs a glance, a missing one can cost a chance.

"why" is one short line the user reads beside it: for now, what it needs from them; for later, what it is; for dropped, \
the topic it fits.

The user is Giao Le, giaolx on Slack, a developer at Ownego on ImagenHub (#imagenhub, #genai-errors, \
#genai-machine-alerts) and Teeinblue (#tib-devops), who is also looking for a new job.

The ordinary topics, for mail:

`;

let timer: ReturnType<typeof setTimeout> | null = null;
let stopped = false;
let wait = EVERY; // ms until the next try: EVERY, doubled after each failure up to half an hour
let said = "";
const missed = new Map<string, number>(); // how many answers left a notice out
const MISSES = 3; // after which it waits, as later, rather than costing a call each minute

// The secretary's ordinary topics, word for word, or "" when the file or the section is gone.
async function ordinary(): Promise<string> {
  const text = await readFile(SECRETARY, "utf8").catch(() => "");
  return text.match(/^## Ordinary topics\n([\s\S]*?)(?=^## |(?![\s\S]))/m)?.[1].trim() ?? "";
}

const local = (at: number) => new Date(at * 1000).toLocaleString("sv-SE", { dateStyle: "short", timeStyle: "short" });

function shown(n: notices.Notice, i: number): string {
  if (n.source === "mail") {
    const [subject, ...rest] = n.text.split("\n");
    return `### ${i}, ${n.place}, from ${n.who}, received ${local(n.at)}\nSubject: ${subject}\nText: ${rest.join(" ")}`;
  }
  const text = n.text.length > TEXT ? `${n.text.slice(0, TEXT)}…` : n.text;
  return `### ${i}, Slack, ${n.place === "DM" ? "a DM" : `in ${n.place}`}, from ${n.who}, sent ${local(n.at)}\n${text}`;
}

async function record(result: Record<string, unknown>) {
  const now = new Date();
  const day = now.toLocaleDateString("sv-SE");
  const line = { ts: now.toISOString(), job: "desk-firewall", result: Object.fromEntries(KEEP.filter((k) => k in result).map((k) => [k, result[k]])) };
  await mkdir(RUNS, { recursive: true });
  await appendFile(join(RUNS, `${day}.jsonl`), `${JSON.stringify(line)}\n`);
}

// One call on up to BATCH notices: each one's verdict, by its id. One the answer leaves out stays unjudged.
async function ask(batch: notices.Notice[]): Promise<Map<string, { verdict: notices.Verdict; why: string }>> {
  const claude = which("claude");
  if (!claude) throw new Error("no claude on desk's PATH");
  const prompt = `It is ${local(Date.now() / 1000)} now.\n\n${batch.map((n, i) => shown(n, i + 1)).join("\n\n")}`;
  const ran = await run([claude, "-p", "--model", MODEL, "--effort", EFFORT, "--safe-mode", "--tools", "", "--no-session-persistence",
    "--strict-mcp-config", "--disable-slash-commands", "--system-prompt", JUDGE + (await ordinary()),
    "--output-format", "json", "--json-schema", JSON.stringify(SCHEMA)], { cwd: "/tmp", input: prompt, timeout: 600 });
  if (ran.code) throw new Error(`claude exited ${ran.code}`);
  const result = JSON.parse(ran.stdout) as Record<string, any>;
  await record(result).catch(() => {});
  const out = new Map<string, { verdict: notices.Verdict; why: string }>();
  for (const v of result.structured_output?.notices ?? []) {
    const n = batch[v.n - 1];
    if (!n || !["now", "later", "dropped"].includes(v.verdict)) continue;
    // A Slack message pops up or waits; a dropped one would be a message the user never sees
    out.set(n.id, { verdict: n.source === "slack" && v.verdict === "dropped" ? "later" : v.verdict, why: String(v.why ?? "").trim() });
  }
  return out;
}

// One round: every unjudged notice judged, BATCH a call. Returns the ones judged, with their verdicts.
export async function round(): Promise<notices.Notice[]> {
  const waiting = await notices.unjudged();
  const judged: notices.Notice[] = [];
  for (let i = 0; i < waiting.length; i += BATCH) {
    const batch = waiting.slice(i, i + BATCH);
    const verdicts = await ask(batch);
    for (const n of batch) {
      let v = verdicts.get(n.id);
      if (!v) {
        missed.set(n.id, (missed.get(n.id) ?? 0) + 1);
        if (missed.get(n.id)! < MISSES) continue;
        v = { verdict: "later", why: "" };
      }
      missed.delete(n.id);
      await notices.judge(n.id, v.verdict, v.why);
      judged.push({ ...n, ...v });
    }
  }
  return judged;
}

export function start() {
  console.log("firewall: judging what comes in each minute");
  const tick = async () => {
    try {
      const judged = await round();
      if (judged.length) {
        const now = judged.filter((n) => n.verdict === "now").length;
        const dropped = judged.filter((n) => n.verdict === "dropped").length;
        console.log(`firewall: ${judged.length} judged, ${now} now, ${judged.length - now - dropped} later, ${dropped} dropped`);
      }
      [wait, said] = [EVERY, ""];
    } catch (e) {
      const message = (e as Error).message;
      if (message !== said) console.error(`firewall: ${message}`);
      [wait, said] = [Math.min(wait * 2, 30 * 60_000), message];
    }
    if (!stopped) timer = setTimeout(tick, wait);
  };
  void tick();
}

export function stop() {
  stopped = true;
  if (timer) clearTimeout(timer);
}
