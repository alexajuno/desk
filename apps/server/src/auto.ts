// Auto, the chip in the composer of desk's own chat (chats.ts, setAuto): as a turn ends on a step's report, desk says
// next for the user, and on a plan, go, as the Go button does. "sometimes i want the agent to just keep going completely
// automated" (the user, 29 Oct), and "auto also say go on the plan". The session's rules stay as they are, each step
// ending its turn, so Manual again stops at the very next step.
//
// It waits for the user, as Manual does, on a question, on the work handed over (a last step's report), on a turn
// the agent ended with no call of its own (one the user stopped, or one an error cut short, which desk
// shows as a reply: pages.ts, advance), on Stop pressed during the turn, and on a reply when no step is left, or none
// moved since desk last said next, so that an agent that ends its Build on a reply rather than handing it over is not
// told next forever.
import * as agents from "./agents.ts";
import * as chats from "./chats.ts";
import * as compact from "./compact.ts";
import * as store from "./issues.ts";
import type { Issue } from "./issues.ts";
import * as turns from "./turns.ts";

interface Step { state?: string; kids?: Step[] }

// When, in ms, each issue's session last handed the user a turn through the API (api.ts): its own call.
const handed = new Map<string, number>();
// When, in ms, the user last pressed Stop in each session (live.ts, interrupt).
const stopped = new Map<string, number>();
// The steps as they stood when desk last said next in each session.
const nexted = new Map<string, string>();
// When, in ms, the turn began that desk last said next or go to, in each session.
const answered = new Map<string, number>();

export const called = (slug: string) => void handed.set(slug, Date.now());
export const stop = (session: string) => void stopped.set(session, Date.now());

const left = (steps: Step[]): boolean => steps.some((s) => s.state !== "done" || left(s.kids ?? []));

function parsed(json: string | null): Step[] {
  try {
    const steps = JSON.parse(json ?? "null");
    return Array.isArray(steps) ? steps : [];
  } catch {
    return [];
  }
}

// When, in ms, the session's last turn began.
const began = (session: string) => (turns.prompted(session) ?? 0) * 1000;

// What Auto says for the user to the turn the session ended, its chat and issue given, or null to wait for them. It only
// looks, so the Inbox asks it too (pages.ts); once desk said it, it holds for that turn, until the session works again.
export function answer(session: string, chat: chats.Chat | null, i: Issue | null): string | null {
  if (!chat?.auto || !i || chat.issue !== i.slug || chats.sessionOfIssue(i.slug) !== session) return null;
  if (i.state !== "review" || (i.review_of !== "reply" && i.review_of !== "plan")) return null;
  const turn = began(session);
  if ((handed.get(i.slug) ?? 0) <= turn || (stopped.get(session) ?? 0) > turn) return null;
  if (i.review_of === "plan") return "Auto: go";
  const steps = i.plan_steps ?? "null";
  if (!left(parsed(steps)) || (nexted.get(session) === steps && answered.get(session) !== turn)) return null;
  return "Auto: next";
}

// Whether Auto carries on in the session, so that the Inbox leaves it out (pages.ts, notifications): a turn of it runs, or
// desk said next or go to the turn it ended, or will. "it shouldn't be in the inbox. only after everything is done" (the
// user, 30 Oct). Each stop Auto waits on reaches the Inbox as in Manual.
export function quiet(session: string, chat: chats.Chat | null, i: Issue | null): boolean {
  if (!chat?.auto || !i || chat.issue !== i.slug || chats.sessionOfIssue(i.slug) !== session) return false;
  return turns.working(session) || answered.get(session) === began(session) || answer(session, chat, i) !== null;
}

// What desk says for the user as the session's turn ends, once a turn, or null to wait for them.
export async function due(session: string): Promise<{ slug: string; say: string } | null> {
  const chat = chats.agentChatOf(session);
  const i = chat?.issue ? await store.load(chat.issue).catch(() => null) : null;
  const say = answer(session, chat, i), turn = began(session);
  if (!say || !i || answered.get(session) === turn) return null;
  answered.set(session, turn);
  if (say === "Auto: next") nexted.set(session, i.plan_steps ?? "null");
  return { slug: i.slug, say };
}

// A break in the work compacts the chat first, in Manual too, so that Auto's next starts from the summary. The host counts
// no slash command as the user's prompt (host.ts, said), so the compaction leaves the issue's review as it was.
async function look(session: string) {
  await compact.atBreak(session);
  const next = await due(session);
  if (!next) return;
  const i = await store.load(next.slug);
  await agents.say(i, next.say).catch((error) => {
    stop(session); // as a Stop: the Inbox shows the turn, rather than wait on a next that never came
    answered.delete(session);
    throw error;
  });
  await store.move(i, { state: "running" }); // as Go does: the session works again
}

export function start() {
  turns.onChange((_sessions, ended) => {
    for (const session of ended) void look(session).catch((error) => console.error("auto", session, error));
  });
}
