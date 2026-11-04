// A chat compacts at a break in its issue's work, rather than at a size: "300k is kinda a hard cap without caring what's
// going on. hard cap in reality is usually wrong" (the user, 30 Oct, on the issue "A long chat tries to compact again on
// every message after I cancel it"). A compaction goes bad "when the model can't predict the direction your work is
// going" (https://claude.com/blog/using-claude-code-session-management-and-1m-context), and at a break desk knows where
// it goes next: the step after the one ticked done. desk compacts the chat as that turn ends, while you read its reply,
// rather than in front of your next message, where it held a message just typed for about 76 s. The last step is no
// break: "after the last step, the issue is done already so no compaction is needed" (the user, 4 Nov).
import * as agents from "./agents.ts";
import * as chats from "./chats.ts";
import * as hosted from "./hosted.ts";

// Tokens a chat holds for a break to compact it, as for coming back to it after an hour (live.ts, compactsFirst).
export const OVER = 100_000;

interface Step { title?: string; state?: string; kids?: Step[] }

// The latest break in each session's issue: what its compaction keeps in focus.
const breaks = new Map<string, string>();

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

// The session's own PATCH, as desk took it in: the issue's steps before it, and the review_of it sent.
export function noted(i: { slug: string; plan_steps: string | null }, before: string | null, reviewOf?: string | null) {
  const session = chats.sessionOfIssue(i.slug), steps = leaves(parsed(i.plan_steps));
  if (!session) return;
  const next = steps.find((s) => s.state !== "done");
  // Every step done or the work handed over: no break, and none an earlier tick of the same turn noted.
  if (!next || reviewOf === "result") breaks.delete(session);
  else if (done(steps) > done(leaves(parsed(before)))) breaks.set(session, `The work goes on to the next step, "${next.title}": keep what it needs.`);
}

// As the session's turn ends: a break noted during it compacts a chat over OVER, counted afresh, since the count desk
// keeps is from before the turn (models.ts). A session still busy in Claude Code's daemon takes no command, and stays
// as it is.
export async function atBreak(session: string) {
  const focus = breaks.get(session);
  if (focus === undefined) return;
  breaks.delete(session);
  const tokens = await hosted.context(session).then((c) => c.tokens, () => 0); // no process holds it: nothing to compact
  if (tokens <= OVER) return;
  await agents.tell(session, `/compact ${focus}`).catch((error) => { if (!(error instanceof agents.Busy)) throw error; });
}
