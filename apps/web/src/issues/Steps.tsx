// A design issue's steps, which its session sets and ticks (api.ts, PlanStep), drawn as Linear draws an issue's
// sub-issues: a row each with the issues' own status circle, its own steps under it on a thin line, a parent's count
// and a step's note in the quiet grey at its end, and the one being worked on filled ("similar statuses for issues i
// suppose?", the user, 27 Oct). The issue's page and the side beside its chat both show it. A step its session drew
// opens under its row, a click away, with its diagram and its decisions: the chat shows only the diagram where it was
// sent ("we had all diagrams on sidebar and it can easily be viewed through artifact view already", 27 Oct). The step
// being worked on starts open.
import { useState } from "react";
import { Counts, showChanges, type StepDiff } from "../sessions/Changes";
import { GLYPH, StateIcon } from "../ui/icons";

// diagram_html and said_html: the step's diagram and decisions, drawn (pages.ts, drawnSteps).
// commit: the one that ends a build step, from which its diff in Changes is drawn (changes.ts).
export type PlanStep = { title: string; state: "todo" | "running" | "done"; note?: string; kids?: PlanStep[]; diagram_html?: string; said_html?: string; commit?: string };

// changes: each step's diff by its place, where its chat has them (Changes.tsx); a step that sent its commit then shows
// how much it changed, and a click on that opens it in the chat's Changes.
export function Steps({ steps, changes, at = "" }: { steps: PlanStep[]; changes?: { slug: string; diffs: Map<string, StepDiff> }; at?: string }) {
  return (
    <ul className="plan-steps">
      {steps.map((s, n) => <StepRow key={n} s={s} place={at ? `${at}.${n + 1}` : `${n + 1}`} changes={changes} />)}
    </ul>
  );
}

function StepRow({ s, place, changes }: { s: PlanStep; place: string; changes?: { slug: string; diffs: Map<string, StepDiff> } }) {
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
  const diff = changes?.diffs.get(place);
  const line = drawn ? (
    <button type="button" className={`plan-step drawn${here ? " here" : ""}${open ? " open" : ""}`} data-state={s.state}
      title={open ? "Hide its diagram" : "Show its diagram"} aria-expanded={open} onClick={() => setOpen(!open)}>{row}</button>
  ) : <div className={`plan-step${here ? " here" : ""}`} data-state={s.state}>{row}</div>;
  return (
    <li>
      {diff ? (
        <div className="plan-step-line">
          {line}
          <button type="button" className="plan-step-counts" title={`Show step ${place}'s changes`} onClick={() => showChanges(changes!.slug, place)}>
            <Counts added={diff.added} deleted={diff.deleted} />
          </button>
        </div>
      ) : line}
      {drawn && open && (
        <div className="plan-step-open">
          {s.diagram_html && <div className="body" dangerouslySetInnerHTML={{ __html: s.diagram_html }} />}
          {s.said_html && <div className="body plan-step-said" dangerouslySetInnerHTML={{ __html: s.said_html }} />}
        </div>
      )}
      {kids.length > 0 && <Steps steps={kids} changes={changes} at={place} />}
    </li>
  );
}
