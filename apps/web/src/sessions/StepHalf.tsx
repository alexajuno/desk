// A design step written as parts, in the chat's right half (Half.tsx): its text is read in the chat, and the half shows
// the diagram of the part being read, which follows the chat's scroll ("text equals to voice on the left and diagrams
// equals to video on the right", the user, 3 Nov; "A" on two mockups, over each part's diagram beside its text in a
// wider chat). On top, the step's name and where in it you read, then its parts as pills, a click on one bringing its
// text into view in the chat, to skip what you know ("i'll try to skip whichever part i felt like i understood"). The
// name leads back to the list, as a breadcrumb does ("there is no button back", the user, 5 Nov).
import { observer } from "mobx-react-lite";
import { useLayoutEffect, useRef, useState } from "react";
import { dock, type Reading } from "../store/dock";
import { partTitle, type PlanStep, type StepPart } from "../issues/Steps";
import { CHEVRON } from "../ui/icons";

// Every step with parts, in the list's order.
const withParts = (steps: PlanStep[]): PlanStep[] => steps.flatMap((s) => [...(s.parts?.length ? [s] : []), ...withParts(s.kids ?? [])]);

// A pill's name: a part's title up to its colon, as "The basics" of "The basics: what a step holds", else all of it.
const short = (p: StepPart) => partTitle(p).split(/:\s/)[0];

export const StepHalf = observer(function StepHalf({ session, steps }: { session: string; steps: PlanStep[] }) {
  const all = withParts(steps), reading = dock.reading[session];
  const step = all.find((s) => s.title === reading?.title) ?? all.at(-1);
  if (!step?.parts) return <p className="step-half-none">No step here is written as parts.</p>;
  const now = step.title === reading?.title ? Math.min(reading.part, step.parts.length - 1) : 0, part = step.parts[now];
  return (
    <div className="step-half">
      <div className="step-half-head">
        <button type="button" className="step-half-back" title="Back to the steps" onClick={() => dock.setHalf(session, "steps", true)}>Steps</button>
        {CHEVRON}
        <span className="step-half-name">{step.title}</span>
        <span className="step-half-at">part {now + 1} of {step.parts.length}</span>
      </div>
      <div className="step-half-pills" role="tablist">
        {step.parts.map((p, n) => (
          <button key={n} type="button" role="tab" aria-selected={n === now} className={`step-half-pill${n === now ? " on" : ""}`} title={partTitle(p)}
            onClick={() => bringPart(session, { title: step.title, part: n })}>
            <span className="step-part-n">{n + 1}</span><span className="step-half-pill-name">{short(p)}</span>
          </button>
        ))}
      </div>
      <h3 className="step-half-title">{partTitle(part)}</h3>
      {part.diagram_html ? <Pictures parts={step.parts} now={now} />
        : <p className="step-half-none">This part has no diagram.</p>}
    </div>
  );
});

// A part's pictures, fitted whole into the room the half leaves them, side by side or one under the other, whichever
// draws them larger, and never past the size d2 drew them: a picture larger than the room ran off the half, and each
// came at its own scale ("the diagram was immediately hard to be seen. the sizes are varied", the user, 3 Nov). The
// parts of a step share one scale, the smallest any of them needs, so that their words keep one size from part to part
// as you read on, down to SHARED; a part that needs less than that shrinks alone. A click opens a picture full size, as
// any picture does (ui/viewer.ts).
const GAP = 16, CAPTION = 20, EDGE = 2, SHARED = 0.75;
type Size = { w: number; h: number };
type Fit = { scale: number; dir: "row" | "column" };

const Pictures = function Pictures({ parts, now }: { parts: StepPart[]; now: number }) {
  const box = useRef<HTMLDivElement>(null);
  const [room, setRoom] = useState<Size | null>(null);
  useLayoutEffect(() => {
    const el = box.current!;
    const look = () => setRoom((r) => (r?.w === el.clientWidth && r.h === el.clientHeight ? r : { w: el.clientWidth, h: el.clientHeight }));
    look();
    const watch = new ResizeObserver(look);
    watch.observe(el);
    return () => watch.disconnect();
  }, []);
  const html = parts[now].diagram_html!;
  const fits = room ? parts.map((p) => (p.diagram_html ? fit(measure(p.diagram_html), room) : null)) : [];
  const own = fits[now];
  const shared = Math.max(SHARED, Math.min(1, ...fits.flatMap((f) => (f ? [f.scale] : []))));
  const scale = own ? Math.min(own.scale, shared) : 1;
  useLayoutEffect(() => {
    const { pics } = measure(html);
    box.current!.querySelectorAll<HTMLElement>(".d2").forEach((d, n) => {
      const pic = pics[n];
      if (pic) d.style.width = `${Math.floor(pic.w * scale) + EDGE}px`;
    });
  }, [html, scale]);
  return <div ref={box} className="step-half-pic body" data-dir={own?.dir ?? "column"} dangerouslySetInnerHTML={{ __html: html }} />;
};

// The size d2 drew each picture of a part at, from its outer svg's viewBox, and whether they carry captions (Today,
// After).
const measured = new Map<string, { pics: Size[]; captions: boolean }>();
function measure(html: string) {
  let known = measured.get(html);
  if (!known) {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const pics = [...doc.querySelectorAll(".d2")].map((d) => {
      const [, , w, h] = (d.querySelector("svg")?.getAttribute("viewBox") ?? "").split(/[\s,]+/).map(Number);
      return { w: w || 1, h: h || 1 };
    });
    known = { pics, captions: Boolean(doc.querySelector("figcaption")) };
    if (measured.size > 200) measured.clear();
    measured.set(html, known);
  }
  return known;
}

// The largest scale at which a part's pictures fit the room, up to the size d2 drew them, and whether side by side.
function fit({ pics, captions }: { pics: Size[]; captions: boolean }, room: Size): Fit {
  if (!pics.length) return { scale: 1, dir: "column" };
  const n = pics.length, cap = captions ? CAPTION : 0;
  const sum = (k: keyof Size) => pics.reduce((a, p) => a + p[k], 0), most = (k: keyof Size) => Math.max(...pics.map((p) => p[k]));
  const row = Math.min((room.w - GAP * (n - 1) - EDGE * n) / sum("w"), (room.h - cap - EDGE) / most("h"));
  const column = Math.min((room.w - EDGE) / most("w"), (room.h - (cap + EDGE) * n - GAP * (n - 1)) / sum("h"));
  const best = row >= column ? { scale: row, dir: "row" as const } : { scale: column, dir: "column" as const };
  return { ...best, scale: Math.max(0.05, Math.min(1, best.scale)) };
}

// A part picked in the half: its text at the top of the chat, and its diagram here, held against that scroll.
function bringPart(session: string, reading: Reading) {
  dock.read(session, reading, true);
  document.querySelector(`.dock .step-sent[data-step="${CSS.escape(reading.title)}"] .step-part[data-part="${reading.part}"]`)
    ?.scrollIntoView({ block: "start", behavior: "instant" });
}

// The part being read in the chat, from its scroll: in a step on screen, the last part whose title is above the reading
// line, two fifths down the view, where the eye reads as it scrolls. Off any step, the part read last stays.
export function followParts(view: HTMLElement, session: string) {
  const box = view.getBoundingClientRect(), line = box.top + box.height * 0.4;
  let found: Reading | null = null;
  for (const step of view.querySelectorAll<HTMLElement>(".step-sent[data-step]")) {
    const at = step.getBoundingClientRect();
    if (at.bottom < box.top || at.top > box.bottom) continue;
    for (const part of step.querySelectorAll<HTMLElement>(".step-part[data-part]")) {
      if (part.getBoundingClientRect().top <= line) found = { title: step.dataset.step!, part: Number(part.dataset.part) };
    }
  }
  if (found) dock.read(session, found);
}
