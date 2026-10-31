// An issue's steps in its chat, in a card above the composer, as Claude's desktop app shows its todo list while it
// works ("i want the steps to be displayed right within the chat tab while it's doing, above the composer", the user,
// 31 Oct; "go with A", on its mockups, over quiet lines and one folded line). The part being worked on is open and the
// step being worked on filled; a part done or still to do folds to its line, and the head folds the whole card to one
// line saying where the work stands, as the card starts unless Settings › Preferences says Expanded, which opens it
// while a step is left ("set it to collapse by default", the user, 1 Nov). A step drawn in the chat brings its message
// into view there, ringed ("valid. proceed", the user, 31 Oct, on its design): the steps' diagrams are read where they
// were sent.
import { useState } from "react";
import { usePage } from "../api/page";
import { CHEVRON, StateIcon } from "../ui/icons";
import { isDrawn, isHere, stepNow, type PlanStep } from "../issues/Steps";

// Folded or open as its default says, until a click says otherwise; a new default, such as the part now being worked
// on, takes the click back.
function useFold(fallback: boolean): [boolean, () => void] {
  const [mine, setMine] = useState<{ fallback: boolean; open: boolean } | null>(null);
  const open = mine && mine.fallback === fallback ? mine.open : fallback;
  return [open, () => setMine({ fallback, open: !open })];
}

// A message of the chat's, by its data-at (Dock.tsx), and an image in it, brought into view under the chat's head, with a
// moment's ring round it so the eye finds it: the foot, the card and the composer, covers the chat's bottom. It jumps
// there, as Slack's jump to a message does: a smooth scroll through a long chat took a second, and the ring faded on the
// way.
export function bring(at: string, img?: number) {
  const msg = document.querySelector(`.dock [data-at="${CSS.escape(at)}"]`);
  const target = (img !== undefined && msg?.querySelectorAll("img")[img]) || msg;
  if (!target) return;
  target.scrollIntoView({ block: "start", behavior: "instant" });
  target.classList.remove("brought");
  void (target as HTMLElement).offsetWidth; // a second click rings it again
  target.classList.add("brought");
}

const leaves = (steps: PlanStep[]): PlanStep[] => steps.flatMap((s) => (s.kids?.length ? leaves(s.kids) : [s]));

// sent: where each step's latest send is in the chat (its data-at), by the step's title.
export function StepsCard({ steps, sent }: { steps: PlanStep[]; sent: ReadonlyMap<string, string> }) {
  const now = stepNow(steps);
  const expanded = usePage<{ steps_card: string }>("/api/settings").data?.steps_card === "expanded";
  const [open, fold] = useFold(expanded && now !== null); // every step done: folded
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
      {open && <FootSteps steps={steps} sent={sent} />}
    </div>
  );
}

function FootSteps({ steps, sent }: { steps: PlanStep[]; sent: ReadonlyMap<string, string> }) {
  return <ul className="foot-steps-list">{steps.map((s, n) => <FootStep key={n} s={s} sent={sent} />)}</ul>;
}

// A step's row: a part opens and folds its own steps, the one being worked on open; a step drawn in the chat brings it.
function FootStep({ s, sent }: { s: PlanStep; sent: ReadonlyMap<string, string> }) {
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
  const at = !kids.length && isDrawn(s) ? sent.get(s.title) : undefined;
  return (
    <li>
      {kids.length ? (
        <button type="button" className={cls} data-state={s.state} aria-expanded={open} title={open ? "Fold its steps" : "Show its steps"} onClick={fold}>{row}</button>
      ) : at ? (
        <button type="button" className={cls} data-state={s.state} title="Show it in the chat" onClick={() => bring(at)}>{row}</button>
      ) : <div className={cls} data-state={s.state}>{row}</div>}
      {kids.length > 0 && open && <FootSteps steps={kids} sent={sent} />}
    </li>
  );
}
