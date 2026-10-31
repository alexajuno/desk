// A design issue's steps, which its session sets and ticks (api.ts, PlanStep), drawn as Linear draws an issue's
// sub-issues: a row each with the issues' own status circle, its own steps under it on a thin line, a parent's count
// and a step's note in the quiet grey at its end, and the one being worked on filled ("similar statuses for issues i
// suppose?", the user, 27 Oct). The issue's page shows it, and its chat a card of it above the composer
// (sessions/StepsCard.tsx). A step its session drew opens under its row, a click away, with its diagram and its
// decisions: the chat shows them where they were sent ("we had all diagrams on sidebar and it can easily be viewed
// through artifact view already", 27 Oct). The step being worked on starts open.
import { useState } from "react";
import { GLYPH, StateIcon } from "../ui/icons";

// diagram_html and said_html: the step's diagram and decisions, drawn (pages.ts, drawnSteps).
// commit: the one that ends a build step, from which its diff in Changes is drawn (changes.ts).
export type PlanStep = { title: string; state: "todo" | "running" | "done"; note?: string; kids?: PlanStep[]; diagram_html?: string; said_html?: string; commit?: string };

export function Steps({ steps }: { steps: PlanStep[] }) {
  return <ul className="plan-steps">{steps.map((s, n) => <StepRow key={n} s={s} />)}</ul>;
}

// The step being worked on, not its parent: running, with no running step of its own.
export const isHere = (s: PlanStep) => s.state === "running" && !(s.kids ?? []).some((k) => k.state === "running");
export const isDrawn = (s: PlanStep) => Boolean(s.diagram_html || s.said_html);

// Where the work stands, for the steps above the composer: the step being worked on, else the next one to do, with its
// place in its part, as Build's second of six. None when every step is done.
export function stepNow(steps: PlanStep[]): { place: string; step: PlanStep; part: string | null; n: number; of: number } | null {
  const leaves = (list: PlanStep[], at: string, part: string | null): { place: string; step: PlanStep; part: string | null; n: number; of: number }[] =>
    list.flatMap((s, i) => {
      const place = at ? `${at}.${i + 1}` : `${i + 1}`;
      return s.kids?.length ? leaves(s.kids, place, s.title) : [{ place, step: s, part, n: i + 1, of: list.length }];
    });
  const all = leaves(steps, "", null);
  return all.find(({ step }) => step.state === "running") ?? all.find(({ step }) => step.state === "todo") ?? null;
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
      {drawn && open && (
        <div className="plan-step-open">
          {s.diagram_html && <div className="body" dangerouslySetInnerHTML={{ __html: s.diagram_html }} />}
          {s.said_html && <div className="body plan-step-said" dangerouslySetInnerHTML={{ __html: s.said_html }} />}
        </div>
      )}
      {kids.length > 0 && <Steps steps={kids} />}
    </li>
  );
}
