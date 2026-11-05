// An issue's steps, which its session sets and ticks (api.ts, PlanStep), drawn as Linear draws an issue's
// sub-issues: a row each with the issues' own status circle, its own steps under it on a thin line, a parent's count
// and a step's note in the quiet grey at its end, and the one being worked on filled ("similar statuses for issues i
// suppose?", the user, 27 Oct). The issue's page shows it, and its chat a view of its right half
// (sessions/StepsHalf.tsx). A step its session drew opens under its row, a click away, with its diagram and its
// decisions, or its parts: the chat shows them where they were sent ("we had all diagrams on sidebar and it can easily be viewed
// through artifact view already", 27 Oct). The step being worked on starts open.
import { useState } from "react";
import { GLYPH, StateIcon } from "../ui/icons";

// diagram_html and said_html: the step's diagram and decisions, drawn (pages.ts, drawnSteps).
// parts: a step written as parts instead (render.ts, takeParts), each its title, its text and its diagram, drawn.
// commit: the one that ends a build step, from which its diff in Changes is drawn (changes.ts).
export type StepPart = { title: string; text_html?: string; diagram_html?: string };
export type PlanStep = { title: string; state: "todo" | "running" | "done"; note?: string; kids?: PlanStep[]; diagram_html?: string; said_html?: string; parts?: StepPart[];
  commit?: string };

export function Steps({ steps }: { steps: PlanStep[] }) {
  return <ul className="plan-steps">{steps.map((s, n) => <StepRow key={n} s={s} />)}</ul>;
}

// The step being worked on, not its parent: running, with no running step of its own.
export const isHere = (s: PlanStep) => s.state === "running" && !(s.kids ?? []).some((k) => k.state === "running");
export const isDrawn = (s: PlanStep) => Boolean(s.diagram_html || s.said_html || s.parts?.length);
// The step whose diagram the chat's list keeps open by itself: the deepest one running that holds something to read.
export function stepOpenNow(steps: PlanStep[]): string | null {
  const s = steps.find((k) => k.state === "running");
  return s ? stepOpenNow(s.kids ?? []) ?? (isDrawn(s) ? s.title : null) : null;
}
export function stepTitled(steps: PlanStep[], title: string): PlanStep | null {
  for (const s of steps) {
    const found = s.title === title ? s : stepTitled(s.kids ?? [], title);
    if (found) return found;
  }
  return null;
}

// A part's title as shown, after its number: any number its session wrote before it goes, as "1. The basics" would read
// "1 1. The basics".
export const partTitle = (p: StepPart) => p.title.replace(/^\d+[.):]\s+/, "");

// A step written as parts, read from the top down, as the user reads an explainer: each part its number and title,
// its text, and its diagram under it, unless the list in the chat's right half shows the diagram of the part being read
// beside the text (sessions/StepHalf.tsx: "text equals to voice on the left and diagrams equals to video on the right", the user,
// 3 Nov), the part being read marked (now). Its decisions come last. body: the class its text takes where it is drawn.
export function StepParts({ parts, said, beside = false, now, body = "body" }: { parts: StepPart[]; said?: string; beside?: boolean; now?: number; body?: string }) {
  return (
    <div className={`step-parts${beside ? " beside" : ""}`}>
      {parts.map((p, n) => (
        <section key={n} className={`step-part${beside && n === now ? " now" : ""}`} data-part={n}>
          <h3 className="step-part-title"><span className="step-part-n">{n + 1}</span>{partTitle(p)}</h3>
          {p.text_html && <div className={body} dangerouslySetInnerHTML={{ __html: p.text_html }} />}
          {!beside && p.diagram_html && <div className={`${body} step-part-pic`} dangerouslySetInnerHTML={{ __html: p.diagram_html }} />}
        </section>
      ))}
      {said && (
        <section className="step-part step-part-said">
          <h3 className="step-part-title">Decisions</h3>
          <div className={body} dangerouslySetInnerHTML={{ __html: said }} />
        </section>
      )}
    </div>
  );
}

// Where the work stands, for the line above the composer: the step being worked on, even with steps of its own while
// none of them runs, else the next one to do, with its place in its part, as a question's second of six. None when every
// step is done.
export function stepNow(steps: PlanStep[]): { place: string; step: PlanStep; part: string | null; n: number; of: number } | null {
  type At = { place: string; step: PlanStep; part: string | null; n: number; of: number };
  const walk = (list: PlanStep[], at: string, part: string | null): At[] =>
    list.flatMap((s, i) => {
      const place = at ? `${at}.${i + 1}` : `${i + 1}`;
      return [{ place, step: s, part, n: i + 1, of: list.length }, ...walk(s.kids ?? [], place, s.title)];
    });
  const all = walk(steps, "", null);
  return all.find(({ step }) => isHere(step)) ?? all.find(({ step }) => step.state === "todo" && !step.kids?.length) ?? null;
}

// What a step holds, opened under its row: its parts, or its diagram and its decisions.
export function StepOpen({ s }: { s: PlanStep }) {
  if (s.parts?.length) return <div className="plan-step-open plan-step-parts"><StepParts parts={s.parts} said={s.said_html} /></div>;
  return (
    <div className="plan-step-open">
      {s.diagram_html && <div className="body" dangerouslySetInnerHTML={{ __html: s.diagram_html }} />}
      {s.said_html && <div className="body plan-step-said" dangerouslySetInnerHTML={{ __html: s.said_html }} />}
    </div>
  );
}

function StepRow({ s }: { s: PlanStep }) {
  const kids = s.kids ?? [];
  const end = kids.length ? `${kids.filter((k) => k.state === "done").length} of ${kids.length}` : s.note;
  const here = isHere(s);
  const drawn = isDrawn(s);
  const [open, setOpen] = useState(here);
  const row = (
    <>
      <span className="plan-step-icon"><StateIcon state={s.state} /></span>
      <span className="plan-step-title">{s.title}</span>
      {end && <span className="plan-step-note">{end}</span>}
      {drawn && <span className="plan-step-drawn">{GLYPH.diagram}</span>}
    </>
  );
  return (
    <li>
      {drawn ? (
        <button type="button" className={`plan-step drawn${here ? " here" : ""}${open ? " open" : ""}`} data-state={s.state}
          title={open ? "Hide its diagram" : "Show its diagram"} aria-expanded={open} onClick={() => setOpen(!open)}>{row}</button>
      ) : <div className={`plan-step${here ? " here" : ""}`} data-state={s.state}>{row}</div>}
      {drawn && open && <StepOpen s={s} />}
      {kids.length > 0 && <Steps steps={kids} />}
    </li>
  );
}
