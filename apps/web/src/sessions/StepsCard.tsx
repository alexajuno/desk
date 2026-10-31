// An issue's steps in its chat, in a card above the composer, as Claude's desktop app shows its todo list while it
// works ("i want the steps to be displayed right within the chat tab while it's doing, above the composer", the user,
// 31 Oct; "go with A", on its mockups, over quiet lines and one folded line). The part being worked on is open and the
// step being worked on filled; a part done or still to do folds to its line, and the head folds the whole card to one
// line saying where the work stands.
import { useState } from "react";
import { CHEVRON, StateIcon } from "../ui/icons";
import { isHere, stepNow, type PlanStep } from "../issues/Steps";

// Folded or open as its default says, until a click says otherwise; a new default, such as the part now being worked
// on, takes the click back.
function useFold(fallback: boolean): [boolean, () => void] {
  const [mine, setMine] = useState<{ fallback: boolean; open: boolean } | null>(null);
  const open = mine && mine.fallback === fallback ? mine.open : fallback;
  return [open, () => setMine({ fallback, open: !open })];
}

const leaves = (steps: PlanStep[]): PlanStep[] => steps.flatMap((s) => (s.kids?.length ? leaves(s.kids) : [s]));

export function StepsCard({ steps }: { steps: PlanStep[] }) {
  const now = stepNow(steps);
  const [open, fold] = useFold(now !== null); // every step done: folded
  if (!steps.length) return null;
  const all = leaves(steps);
  const at = now ? [now.part, `${now.n} of ${now.of}`].filter(Boolean).join(" · ") : `all ${all.length} done`;
  return (
    <div className={`foot-steps${open ? " open" : ""}`}>
      <button type="button" className="foot-steps-head" aria-expanded={open} title={open ? "Fold the steps" : "Show the steps"} onClick={fold}>
        <span className="foot-steps-name">Steps</span>
        <span className="foot-steps-at">{at}</span>
        {!open && now && <span className="foot-steps-now">{now.step.title}</span>}
        <span className="foot-steps-fold">{CHEVRON}</span>
      </button>
      {open && <FootSteps steps={steps} />}
    </div>
  );
}

function FootSteps({ steps }: { steps: PlanStep[] }) {
  return <ul className="foot-steps-list">{steps.map((s, n) => <FootStep key={n} s={s} />)}</ul>;
}

// A step's row: a part opens and folds its own steps, the one being worked on open.
function FootStep({ s }: { s: PlanStep }) {
  const kids = s.kids ?? [];
  const [open, fold] = useFold(s.state === "running");
  const end = kids.length ? `${kids.filter((k) => k.state === "done").length} of ${kids.length}` : s.note;
  const row = (
    <>
      <span className="foot-step-icon"><StateIcon state={s.state} /></span>
      <span className="foot-step-title">{s.title}</span>
      {end && <span className="foot-step-end">{end}</span>}
    </>
  );
  const cls = `foot-step${kids.length ? " part" : ""}${isHere(s) ? " here" : ""}`;
  return (
    <li>
      {kids.length ? (
        <button type="button" className={cls} data-state={s.state} aria-expanded={open} title={open ? "Fold its steps" : "Show its steps"} onClick={fold}>{row}</button>
      ) : <div className={cls} data-state={s.state}>{row}</div>}
      {kids.length > 0 && open && <FootSteps steps={kids} />}
    </li>
  );
}
