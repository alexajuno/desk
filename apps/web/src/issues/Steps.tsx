// A design issue's steps, which its session sets and ticks (api.ts, PlanStep), drawn as Linear draws an issue's
// sub-issues: a row each with the issues' own status circle, its own steps under it on a thin line, a parent's count
// and a step's note in the quiet grey at its end, and the one being worked on filled ("similar statuses for issues i
// suppose?", the user, 27 Oct). The issue's page and the side beside its chat both show it. A step its session drew
// opens under its row, a click away, with its diagram and its decisions: the chat shows only the diagram where it was
// sent ("we had all diagrams on sidebar and it can easily be viewed through artifact view already", 27 Oct). The step
// being worked on starts open.
import { useState } from "react";
import { GLYPH, StateIcon } from "../ui/icons";

// diagram_html and said_html: the step's diagram and decisions, drawn (pages.ts, drawnSteps).
export type PlanStep = { title: string; state: "todo" | "running" | "done"; note?: string; kids?: PlanStep[]; diagram_html?: string; said_html?: string };

export function Steps({ steps }: { steps: PlanStep[] }) {
  return (
    <ul className="plan-steps">
      {steps.map((s, n) => <StepRow key={n} s={s} />)}
    </ul>
  );
}

function StepRow({ s }: { s: PlanStep }) {
  const kids = s.kids ?? [];
  const end = kids.length ? `${kids.filter((k) => k.state === "done").length} of ${kids.length}` : s.note;
  const here = s.state === "running" && !kids.some((k) => k.state === "running"); // the one being worked on, not its parent
  const drawn = Boolean(s.diagram_html || s.said_html);
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
