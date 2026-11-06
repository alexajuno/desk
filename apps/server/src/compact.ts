// A chat compacts at a break in its issue's work, as its turn ends, while you read its reply, by two rules: "we'll have
// fixed rule and AI's rule. fixed rule is auto compact at step done and over certain amount of context window" (the user,
// 6 Nov, on the issue "Compact a chat at a real break, now steps aren't fixed"). The fixed rule is a step ticked done with
// another to go; the chat's own is the `compact` it sends with a call, for a break no tick shows, as a review or a deploy
// has none: "not all tasks are about commits", "we'll let the chat decides itself is valid" (6 Nov). A chat cannot run
// /compact itself, since it runs between turns, so desk sends it. Both hold to one floor, Settings' compact_over. At 100k, until 5 Nov, a tick
// restarted a talk three times while it still needed its context; a compacted chat reads about 70k on its next turn, so
// that floor spared it little: "i don't think 150k is valid. higher i suppose. 300k" (6 Nov). A question needs its context
// to take your answer, and "after the last step, the issue is done already so no compaction is needed" (4 Nov).
import * as agents from "./agents.ts";
import * as chats from "./chats.ts";
import * as hosted from "./hosted.ts";
import * as store from "./issues.ts";
import * as settings from "./settings.ts";

interface Step { title?: string; state?: string; kids?: Step[] }

// The latest break in each session's turn: its issue, and what its compaction keeps in focus.
const breaks = new Map<string, { slug: string; focus: string }>();

function parsed(json: string | null): Step[] {
  try {
    const steps = JSON.parse(json ?? "null");
    return Array.isArray(steps) ? steps : [];
  } catch {
    return [];
  }
}

// The steps that are work themselves, in order: those with no steps of their own.
const leaves = (steps: Step[]): Step[] => steps.flatMap((s) => (s.kids?.length ? leaves(s.kids) : [s]));
const done = (steps: Step[]) => steps.filter((s) => s.state === "done").length;

// The session's own PATCH, as desk took it in: the issue's steps before it, and the focus it asked to compact on, if any.
export function noted(i: { slug: string; plan_steps: string | null }, before: string | null, asked?: string) {
  const session = chats.sessionOfIssue(i.slug), steps = leaves(parsed(i.plan_steps));
  if (!session) return;
  const next = steps.find((s) => s.state !== "done");
  if (asked) breaks.set(session, { slug: i.slug, focus: asked });
  else if (!next) breaks.delete(session); // every step done: no break, and none an earlier tick of the same turn noted
  else if (done(steps) > done(leaves(parsed(before)))) breaks.set(session, { slug: i.slug, focus: `The work goes on to the next step, "${next.title}": keep what it needs.` });
}

// A turn the user stopped holds its break back: the message they stop to write should not wait on a compaction.
export const drop = (session: string) => void breaks.delete(session);

// As the session's turn ends: a break noted during it compacts a chat over the floor, counted afresh, since the count desk
// keeps is from before the turn (models.ts). The issue is read now, as however many calls the turn made left it. A session
// still busy in Claude Code's daemon takes no command, and stays as it is.
export async function atBreak(session: string) {
  const at = breaks.get(session);
  if (!at) return;
  breaks.delete(session);
  const i = await store.load(at.slug).catch(() => null);
  if (!i || i.state === "done" || i.state === "dropped") return;
  if (i.state === "review" && (i.review_of === "question" || i.review_of === "result")) return;
  const tokens = await hosted.context(session).then((c) => c.tokens, () => 0); // no process holds it: nothing to compact
  if (tokens <= settings.load().compact_over) return;
  await agents.tell(session, `/compact ${at.focus}`).catch((error) => { if (!(error instanceof agents.Busy)) throw error; });
}
