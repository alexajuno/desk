// An issue's steps in its chat: the list, a view of its right half (Half.tsx), and one line above the composer saying
// what is being worked on while the list is closed. The list outgrew a card above the composer, and each step's answer
// needs a line of its own ("this gonna expand the plan card a lot, so the card can't be above the composer anymore", the
// user, 5 Nov, taking back "i want the steps to be displayed right within the chat tab while it's doing, above the
// composer", 31 Oct). A row is a step's title with its note under it; its own steps sit under it, the part being worked
// on open and the step being worked on filled, and a part done or still to do folds to its row. What a step holds opens
// under its row, the step being worked on by itself and any other by a click, which also brings its message into view in
// the chat, ringed, so that nothing takes the list's place ("the diagram grows itself", "as before, we used to have that",
// the user, 5 Nov). A commit opens the Changes. The line only says, since what opens the half is in
// the chat's head ("having these icons in composer doesn't sound valid", 1 Nov).
import { observer } from "mobx-react-lite";
import { useEffect, useRef, useState } from "react";
import { dock } from "../store/dock";
import { CHEVRON, GLYPH, StateIcon } from "../ui/icons";
import { isDrawn, isHere, placeOf, StepOpen, stepNow, stepOpenNow, type PlanStep } from "../issues/Steps";
import { StepBeside, StepHeld } from "./StepHalf";

const phone = matchMedia("(max-width: 640px)"); // where the half takes the chat's place (phone.css)

// Folded or open as its default says, until a click says otherwise; a new default, such as the part now being worked
// on, takes the click back.
function useFold(fallback: boolean): [boolean, () => void] {
  const [mine, setMine] = useState<{ fallback: boolean; open: boolean } | null>(null);
  const open = mine && mine.fallback === fallback ? mine.open : fallback;
  return [open, () => setMine({ fallback, open: !open })];
}

// A message of the chat's, by its data-at (Dock.tsx), and an image in it, brought into view under the chat's head, with a
// moment's ring round it so the eye finds it. It jumps there, as Slack's jump to a message does: a smooth scroll through a
// long chat took a second, and the ring faded on the way.
export function bring(at: string, img?: number) {
  const msg = document.querySelector(`.dock [data-at="${CSS.escape(at)}"]`);
  const target = (img !== undefined && msg?.querySelectorAll("img")[img]) || msg;
  if (!target) return;
  target.scrollIntoView({ block: "start", behavior: "instant" });
  target.classList.remove("brought");
  void (target as HTMLElement).offsetWidth; // a second click rings it again
  target.classList.add("brought");
}

// What is being worked on, or else what comes next, above the composer. Nothing once every step is done.
export function StepsLine({ steps }: { steps: PlanStep[] }) {
  const now = stepNow(steps);
  if (!now) return null;
  return (
    <div className="steps-line">
      <span className="steps-row-icon"><StateIcon state={now.step.state} /></span>
      <span className="steps-line-now"><span className="steps-row-num">{placeOf(steps, now.step)}</span>{now.step.title}</span>
      {now.part && <span className="steps-line-at">{now.part} · {now.n} of {now.of}</span>}
    </div>
  );
}

// sent: where each step's latest send is in the chat (its data-at), by the step's title.
type Sent = ReadonlyMap<string, string>;

export const StepsHalf = observer(function StepsHalf({ session, steps, sent }: { session: string; steps: PlanStep[]; sent: Sent }) {
  const now = stepOpenNow(steps);
  return <div className="steps-half"><StepsRows session={session} steps={steps} sent={sent} now={now} open={dock.rowOpen(session, now)} /></div>;
});

// now: the step being worked on that holds something to read; open: the row open under its title.
type Rows = { session: string; sent: Sent; now: string | null; open: string | null };

function StepsRows({ steps, prefix = "", ...rows }: Rows & { steps: PlanStep[]; prefix?: string }) {
  return <ul className="steps-rows">{steps.map((s, n) => <StepsRow key={n} s={s} place={`${prefix}${n + 1}`} {...rows} />)}</ul>;
}

const holds = (s: PlanStep, title: string | null): boolean => (s.kids ?? []).some((k) => k.title === title || holds(k, title));

function StepsRow({ s, place, ...rows }: Rows & { s: PlanStep; place: string }) {
  const { session, sent, now } = rows;
  const kids = s.kids ?? [];
  const [open, fold] = useFold(s.state === "running" || holds(s, rows.open));
  const drawn = isDrawn(s), at = drawn ? sent.get(s.title) : undefined, held = rows.open === s.title;
  const opened = useRef<HTMLDivElement>(null);
  useEffect(() => { if (held) opened.current?.scrollIntoView({ block: "nearest" }); }, [held]);
  const pickRow = () => {
    dock.pickRow(session, held ? null : s.title, now);
    // A frame later than the chat redrawing what the row now holds. The half covers a phone's chat.
    if (!held && at && !phone.matches) requestAnimationFrame(() => requestAnimationFrame(() => bring(at)));
  };
  const words = (
    <>
      <span className="steps-row-icon"><StateIcon state={s.state} /></span>
      <span className="steps-row-num">{place}</span>
      <span className="steps-row-title">{s.title}</span>
      {s.note && <span className="steps-row-note">{s.note}</span>}
    </>
  );
  const foldTitle = open ? "Fold its steps" : "Show its steps";
  const pick = drawn ? { title: held ? "Hide what it holds" : "Show what it holds", run: pickRow }
    : kids.length ? { title: foldTitle, run: fold } : null;
  return (
    <li>
      <div className={`steps-row${kids.length ? " part" : ""}${isHere(s) ? " here" : ""}${pick ? " can" : ""}`} data-state={s.state}>
        {pick ? <button type="button" className="steps-row-main" title={pick.title} onClick={pick.run}>{words}</button>
          : <div className="steps-row-main">{words}</div>}
        <span className="steps-row-end">
          {s.commit && <button type="button" className="steps-row-commit" title="Its diff, in Changes" onClick={() => dock.setHalf(session, "changes", true)}>{s.commit.slice(0, 7)}</button>}
          {drawn && <span className="steps-row-drawn" title="It holds decisions or a diagram">{GLYPH.diagram}</span>}
          {kids.length > 0 && `${kids.filter((k) => k.state === "done").length} of ${kids.length}`}
          {kids.length > 0 && <button type="button" className={`steps-row-fold${open ? " open" : ""}`} title={foldTitle} aria-expanded={open} onClick={fold}>{CHEVRON}</button>}
        </span>
      </div>
      {held && <div ref={opened}>{!s.parts?.length ? <StepHeld s={s} /> : phone.matches ? <StepOpen s={s} /> : <StepBeside session={session} step={s} />}</div>}
      {kids.length > 0 && open && <StepsRows steps={kids} prefix={`${place}.`} {...rows} />}
    </li>
  );
}
