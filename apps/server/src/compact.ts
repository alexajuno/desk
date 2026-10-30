// A chat compacts at a break in its issue's work, rather than at a size: "300k is kinda a hard cap without caring what's
// going on. hard cap in reality is usually wrong" (the user, 30 Oct, on the issue "A long chat tries to compact again on
// every message after I cancel it"). A compaction goes bad "when the model can't predict the direction your work is
// going" (https://claude.com/blog/using-claude-code-session-management-and-1m-context), and at a break desk knows where
// it goes next: the step after the one ticked done, or the review of the Result just sent.

interface Step { title?: string; state?: string; kids?: Step[] }

// What each issue's work goes on to, noted at its latest break: the focus its compaction keeps.
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
  const steps = leaves(parsed(i.plan_steps));
  if (reviewOf === "result") breaks.set(i.slug, "the Result just sent, the review of it and how the work lands");
  else if (done(steps) > done(leaves(parsed(before)))) {
    const next = steps.find((s) => s.state !== "done");
    breaks.set(i.slug, next ? `the next step, "${next.title}"` : "the Result, as every step is done");
  }
}
