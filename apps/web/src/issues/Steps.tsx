// A design issue's steps, which its session sets and ticks (api.ts, PlanStep), drawn as Linear draws an issue's
// sub-issues: a row each with the issues' own status circle, its own steps under it on a thin line, a parent's count
// and a step's note in the quiet grey at its end, and the one being worked on filled ("similar statuses for issues i
// suppose?", the user, 27 Oct). The issue's page and the side beside its chat both show it.
import { StateIcon } from "../ui/icons";

// diagram_html and said_html: the step's diagram and decisions, drawn (pages.ts, drawnSteps).
export type PlanStep = { title: string; state: "todo" | "running" | "done"; note?: string; kids?: PlanStep[]; diagram_html?: string; said_html?: string };

export function Steps({ steps }: { steps: PlanStep[] }) {
  return (
    <ul className="plan-steps">
      {steps.map((s, n) => {
        const kids = s.kids ?? [];
        const end = kids.length ? `${kids.filter((k) => k.state === "done").length} of ${kids.length}` : s.note;
        const here = s.state === "running" && !kids.some((k) => k.state === "running"); // the one being worked on, not its parent
        return (
          <li key={n}>
            <div className={`plan-step${here ? " here" : ""}`} data-state={s.state}>
              <span className="plan-step-icon"><StateIcon state={s.state} /></span>
              <span className="plan-step-title">{s.title}</span>
              {end && <span className="plan-step-note">{end}</span>}
            </div>
            {kids.length > 0 && <Steps steps={kids} />}
          </li>
        );
      })}
    </ul>
  );
}
