// What a step holds, under its row in the list of the chat's right half (StepsHalf.tsx): its diagram and its decisions.
// A step written as parts has its text read in the chat, and shows here the diagram of the part being read, which follows
// the chat's scroll ("text equals to voice on the left and diagrams equals to video on the right", the user, 3 Nov; "A" on
// two mockups, over each part's diagram beside its text in a wider chat), with its parts as pills, a click on one bringing
// its text into view in the chat, to skip what you know ("i'll try to skip whichever part i felt like i understood").
// Until 5 Nov it was a view of its own that took the list's place ("click into a step shows the diagram, but there is no
// button back. and i don't think it's a good choice either", the user).
import { observer } from "mobx-react-lite";
import { useLayoutEffect, useRef, useState } from "react";
import { dock, type Reading } from "../store/dock";
import { partTitle, type PlanStep, type StepPart } from "../issues/Steps";

// A pill's name: a part's title up to its colon, as "The basics" of "The basics: what a step holds", else all of it.
const short = (p: StepPart) => partTitle(p).split(/:\s/)[0];

export const StepBeside = observer(function StepBeside({ session, step }: { session: string; step: PlanStep }) {
  const parts = step.parts ?? [], reading = dock.reading[session];
  const now = step.title === reading?.title ? Math.min(reading.part, parts.length - 1) : 0, part = parts[now];
  return (
    <div className="step-half">
      <div className="step-half-pills" role="tablist">
        {parts.map((p, n) => (
          <button key={n} type="button" role="tab" aria-selected={n === now} className={`step-half-pill${n === now ? " on" : ""}`} title={partTitle(p)}
            onClick={() => bringPart(session, { title: step.title, part: n })}>
            <span className="step-part-n">{n + 1}</span><span className="step-half-pill-name">{short(p)}</span>
          </button>
        ))}
      </div>
      <h3 className="step-half-title">{partTitle(part)}</h3>
      {part.diagram_html ? <Pictures all={parts.map((p) => p.diagram_html)} now={now} />
        : <p className="step-half-none">This part has no diagram.</p>}
    </div>
  );
});

// A step with no parts: its diagram, then its decisions.
export function StepHeld({ s }: { s: PlanStep }) {
  return (
    <div className="step-half">
      {s.diagram_html && <Pictures all={[s.diagram_html]} now={0} />}
      {s.said_html && <div className="body plan-step-said step-half-said" dangerouslySetInnerHTML={{ __html: s.said_html }} />}
    </div>
  );
}

// A part's pictures, fitted whole into the half's width and at most TALL of the window's height, side by side or one under
// the other, whichever draws them larger, and never past the size d2 drew them: a picture larger than the room ran off the
// half, and each came at its own scale ("the diagram was immediately hard to be seen. the sizes are varied", the user, 3
// Nov). The parts of a step share one scale, the smallest any of them needs, so that their words keep one size from part
// to part as you read on, down to SHARED; a part that needs less than that shrinks alone. A click opens a picture full
// size, as any picture does (ui/viewer.ts).
const GAP = 16, CAPTION = 20, EDGE = 2, SHARED = 0.75, TALL = 0.6;
type Size = { w: number; h: number };
type Fit = { scale: number; dir: "row" | "column" };

const Pictures = function Pictures({ all, now }: { all: (string | undefined)[]; now: number }) {
  const box = useRef<HTMLDivElement>(null);
  const [room, setRoom] = useState<Size | null>(null);
  useLayoutEffect(() => {
    const el = box.current!;
    const look = () => {
      const h = Math.round(innerHeight * TALL);
      setRoom((r) => (r?.w === el.clientWidth && r.h === h ? r : { w: el.clientWidth, h }));
    };
    look();
    const watch = new ResizeObserver(look);
    watch.observe(el);
    return () => watch.disconnect();
  }, []);
  const html = all[now]!;
  const fits = room ? all.map((p) => (p ? fit(measure(p), room) : null)) : [];
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

// A part picked in the list: its text at the top of the chat, and its diagram here, held against that scroll.
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
