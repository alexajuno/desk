// A design issue's steps, which its session sets and ticks (api.ts, PlanStep), drawn as Linear draws an issue's
// sub-issues: a row each with the issues' own status circle, its own steps under it on a thin line, a parent's count
// and a step's note in the quiet grey at its end, and the one being worked on filled ("similar statuses for issues i
// suppose?", the user, 27 Oct). The issue's page and the side beside its chat both show it.
import { StateIcon } from "../ui/icons";

export type PlanStep = { title: string; state: "todo" | "running" | "done"; note?: string; kids?: PlanStep[] };

export function Steps({ steps }: { steps: PlanStep[] }) {
  return (
    <ul className="steps">
      {steps.map((s, n) => {
        const kids = s.kids ?? [];
        const end = kids.length ? `${kids.filter((k) => k.state === "done").length} of ${kids.length}` : s.note;
        return (
          <li key={n}>
            <div className={`step${s.state === "running" ? " here" : ""}`} data-state={s.state}>
              <span className="step-icon"><StateIcon state={s.state} /></span>
              <span className="step-title">{s.title}</span>
              {end && <span className="step-note">{end}</span>}
            </div>
            {kids.length > 0 && <Steps steps={kids} />}
          </li>
        );
      })}
    </ul>
  );
}
