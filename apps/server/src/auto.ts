// Auto, the chip in the composer of desk's own chat (chats.ts, setAuto): as a turn ends on a step's report, desk says
// next for the user, and on a plan, go, as the Go button does. "sometimes i want the agent to just keep going completely
// automated" (the user, 29 Oct), and "auto also say go on the plan". The session's rules stay as they are, each step
// ending its turn, so Manual again stops at the very next step.
//
// It waits for the user, as Manual does, on a question, on the card, on a turn the agent ended with no call of its own
// (one the user stopped, or one an error cut short, which desk shows as a reply: pages.ts, advance), on Stop pressed
// during the turn, and on a reply when no step is left, or none moved since desk last said next, so that an agent that
// ends its Build on a reply rather than its card is not told next forever.
import * as agents from "./agents.ts";
import * as chats from "./chats.ts";
import * as store from "./issues.ts";
import * as turns from "./turns.ts";

interface Step { state?: string; kids?: Step[] }

// When, in ms, each issue's session last handed the user a turn through the API (api.ts): its own call.
const handed = new Map<string, number>();
// When, in ms, the user last pressed Stop in each session (live.ts, interrupt).
const stopped = new Map<string, number>();
// The steps as they stood when desk last said next in each session.
const nexted = new Map<string, string>();

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

// What desk says for the user as the session's turn ends, or null to wait for them.
export async function due(session: string): Promise<{ slug: string; say: string } | null> {
  const chat = chats.agentChatOf(session);
  if (!chat?.auto || !chat.issue || chats.sessionOfIssue(chat.issue) !== session) return null;
  const i = await store.load(chat.issue).catch(() => null);
  if (!i || i.state !== "review" || (i.review_of !== "reply" && i.review_of !== "plan")) return null;
  const began = (turns.prompted(session) ?? 0) * 1000;
  if ((handed.get(i.slug) ?? 0) <= began || (stopped.get(session) ?? 0) > began) return null;
  if (i.review_of === "plan") return { slug: i.slug, say: "Auto: go" };
  const steps = i.plan_steps ?? "null";
  if (!left(parsed(steps)) || nexted.get(session) === steps) return null;
  nexted.set(session, steps);
  return { slug: i.slug, say: "Auto: next" };
}

async function look(session: string) {
  const next = await due(session);
  if (!next) return;
  const i = await store.load(next.slug);
  await agents.say(i, next.say);
  await store.move(i, { state: "running" }); // as Go does: the session works again
}

export function start() {
  turns.onChange((_sessions, ended) => {
    for (const session of ended) void look(session).catch((error) => console.error("auto", session, error));
  });
}
