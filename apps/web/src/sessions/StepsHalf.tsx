// An issue's steps in its chat: the list, a view of its right half (Half.tsx), and one line above the composer saying
// what is being worked on while the list is closed. The list outgrew a card above the composer, and each step's answer
// needs a line of its own ("this gonna expand the plan card a lot, so the card can't be above the composer anymore", the
// user, 5 Nov, taking back "i want the steps to be displayed right within the chat tab while it's doing, above the
// composer", 31 Oct). A row is a step's title with its note under it; its own steps sit under it, the part being worked
// on open and the step being worked on filled, and a part done or still to do folds to its row. A click never takes the
// list away ("click into a step shows the diagram, but there is no button back. and i don't think it's a good choice
// either", the user, 5 Nov): a step drawn in the chat brings its message into view there, ringed, and one whose send the
// chat doesn't hold opens under its row. A commit opens the Changes. The line only says, since what opens the half is in
// the chat's head ("having these icons in composer doesn't sound valid", 1 Nov).
import { useState } from "react";
import { dock } from "../store/dock";
import { CHEVRON, GLYPH, StateIcon } from "../ui/icons";
import { isDrawn, isHere, StepOpen, stepNow, type PlanStep } from "../issues/Steps";

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

// A step drawn in the chat, picked in the list: the list stays beside its message, whose diagrams draw under their text
// while the half isn't on them. On a phone the half gives the chat its place back first.
function bringStep(session: string, at: string) {
  if (phone.matches) dock.setHalf(session, null);
  // A frame later than the chat's own keeping to its end, which a phone's chat, shown again, does in the first.
  requestAnimationFrame(() => requestAnimationFrame(() => bring(at)));
}

// What is being worked on, or else what comes next, above the composer. Nothing once every step is done.
export function StepsLine({ steps }: { steps: PlanStep[] }) {
  const now = stepNow(steps);
  if (!now) return null;
  return (
    <div className="steps-line">
      <span className="steps-row-icon"><StateIcon state={now.step.state} /></span>
      <span className="steps-line-now">{now.step.title}</span>
      {now.part && <span className="steps-line-at">{now.part} · {now.n} of {now.of}</span>}
    </div>
  );
}

// sent: where each step's latest send is in the chat (its data-at), by the step's title.
type Sent = ReadonlyMap<string, string>;

export function StepsHalf({ session, steps, sent }: { session: string; steps: PlanStep[]; sent: Sent }) {
  return <div className="steps-half"><StepsRows session={session} steps={steps} sent={sent} /></div>;
}

function StepsRows({ session, steps, sent }: { session: string; steps: PlanStep[]; sent: Sent }) {
  return <ul className="steps-rows">{steps.map((s, n) => <StepsRow key={n} session={session} s={s} sent={sent} />)}</ul>;
}

function StepsRow({ session, s, sent }: { session: string; s: PlanStep; sent: Sent }) {
  const kids = s.kids ?? [];
  const [open, fold] = useFold(s.state === "running");
  const [held, setHeld] = useState(false); // what it holds, under its row, when the chat has no send of it to bring
  const drawn = isDrawn(s), at = drawn ? sent.get(s.title) : undefined;
  const words = (
    <>
      <span className="steps-row-icon"><StateIcon state={s.state} /></span>
      <span className="steps-row-title">{s.title}</span>
      {s.note && <span className="steps-row-note">{s.note}</span>}
    </>
  );
  const foldTitle = open ? "Fold its steps" : "Show its steps";
  const pick = at ? { title: "Show it in the chat", run: () => bringStep(session, at) }
    : drawn ? { title: held ? "Hide what it holds" : "Show what it holds", run: () => setHeld(!held) }
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
      {held && <StepOpen s={s} />}
      {kids.length > 0 && open && <StepsRows session={session} steps={kids} sent={sent} />}
    </li>
  );
}
