// An issue's Changes, the tab beside its chat: a card per build step, holding the step's diff from the commit its
// session sent as it ticked the step (changes.ts). "we have diff show while coding, allowing user to catches the
// problem early" (the user, 28 Oct). The lines are drawn as Linear Diffs draws them, measured on the demo on
// linear.app's Reviews page on 28 Oct: one number column, a tinted line with a coloured edge for what was added or
// deleted, and the counts in green and red.
import { observable, runInAction } from "mobx";
import { observer } from "mobx-react-lite";
import { Fragment, useEffect, useRef, useState } from "react";
import { usePage } from "../api/page";
import type { PlanStep } from "../issues/Steps";
import { dock } from "../store/dock";
import { StateIcon, TRIANGLE } from "../ui/icons";
import { toast } from "../ui/toast";
import { toggleIssue } from "./Dock";
import { live } from "./live";

type Line = [kind: " " | "+" | "-", old: number | null, now: number | null, text: string];
type FileDiff = { path: string; was?: string; added: number; deleted: number; binary?: true; cut?: true; hunks: { header: string; lines: Line[] }[] };
export type StepDiff = { place: string; title: string; state: PlanStep["state"]; note?: string; commit: string; added: number; deleted: number; files: FileDiff[] };

// A file with more changed lines than this starts folded, so one big file doesn't bury the rest.
const OPEN_LINES = 400;

export const useChanges = (slug: string) => usePage<{ steps: StepDiff[] }>(`/api/page/issue/${slug}/changes`).data?.steps ?? null;

// Whether any of the steps carries a commit, so has a diff to show.
export const anyCommit = (steps: (PlanStep & { commit?: string })[] | null | undefined): boolean =>
  Boolean(steps?.some((s) => s.commit || anyCommit(s.kids)));

// A step to show in its chat's Changes, asked for by a click on its counts in the steps over the chat (Steps.tsx): the
// chat turns to Changes, and that step's card opens and comes into view.
export const wanted = observable.box<{ slug: string; place: string } | null>(null, { deep: false });
// The sheet the steps are on lies over the chat, so it steps aside for it.
export function showChanges(slug: string, place: string) {
  runInAction(() => wanted.set({ slug, place }));
  if (dock.sheetShown) toggleIssue();
}

// Lines picked in a step's diff to comment on, as GitHub's + picks them: a click on a line's number picks the line, and
// a drag along the numbers or a shift-click picks a range, inside the hunk it started in ("line selection effect similar
// to github's", the user, 28 Oct). from is where the pick started and to where it ends, either way round; drag holds
// while the mouse is down.
type Picked = { place: string; path: string; hunk: number; from: number; to: number; drag: boolean };
export const picked = observable.box<Picked | null>(null, { deep: false });

// What is typed in the box under the picked lines: kept while the pick grows, shrinks or moves, dropped with it.
const words = observable.box("");

// Esc drops the pick (Frame.tsx, and the box's own Esc), and what was typed for it.
export function dropPick(): boolean {
  if (!picked.get()) return false;
  runInAction(() => { picked.set(null); words.set(""); });
  return true;
}

// Lines of a diff quoted for the chat, with their step, file and line numbers, as the steps rule tells a session to read
// them (prompts.ts): "Step 2.1, apps/server/src/api.ts:222", then the lines in a diff block.
function quoted(place: string, path: string, lines: Line[]) {
  const no = ([kind, old, now]: Line) => (kind === "-" ? old : now);
  const [from, to] = [no(lines[0]), no(lines[lines.length - 1])];
  return `Step ${place}, ${path}:${from === to ? from : `${from}-${to}`}\n\`\`\`diff\n${lines.map((l) => l[0] + l[3]).join("\n")}\n\`\`\`\n`;
}

const rowAt = (target: EventTarget) => (target as Element).closest<HTMLTableRowElement>("tr[data-i]");

function pickDown(e: React.MouseEvent, path: string) {
  const row = rowAt(e.target);
  if (e.button !== 0 || !row || !(e.target as Element).closest(".diff-no")) return;
  e.preventDefault(); // no text selection from the numbers
  const place = row.closest<HTMLElement>("[data-place]")!.dataset.place!, hunk = +row.dataset.hunk!, i = +row.dataset.i!;
  const p = picked.get();
  const extend = e.shiftKey && p && p.place === place && p.path === path && p.hunk === hunk;
  runInAction(() => picked.set(extend ? { ...p, to: i, drag: true } : { place, path, hunk, from: i, to: i, drag: true }));
  addEventListener("mouseup", () => runInAction(() => { const q = picked.get(); if (q) picked.set({ ...q, drag: false }); }), { once: true });
}

function pickOver(e: React.MouseEvent, path: string) {
  const p = picked.get(), row = rowAt(e.target);
  if (!p?.drag || !row || p.path !== path || +row.dataset.hunk! !== p.hunk || row.closest<HTMLElement>("[data-place]")!.dataset.place !== p.place) return;
  if (+row.dataset.i! !== p.to) runInAction(() => picked.set({ ...p, to: +row.dataset.i! }));
}

// C on a line of a diff picks it and opens the box under it, as a click on its number does; on a line already picked it
// goes back into the box. Over Changes but off its lines it says how, rather than filing a new issue, which C does
// elsewhere (Frame.tsx). Selecting the code's text only copies it.
export function commentKey(): boolean {
  const row = document.querySelector<HTMLTableRowElement>(".changes table.diff tr[data-i]:hover");
  if (!row) return Boolean(document.querySelector(".changes:hover") && (toast("Point at a line to comment on it, or click its number"), true));
  const place = row.closest<HTMLElement>("[data-place]")!.dataset.place!, path = row.closest<HTMLElement>("[data-path]")!.dataset.path!;
  const hunk = +row.dataset.hunk!, i = +row.dataset.i!, p = picked.get();
  const inside = p && p.place === place && p.path === path && p.hunk === hunk && i >= Math.min(p.from, p.to) && i <= Math.max(p.from, p.to);
  if (!inside) runInAction(() => picked.set({ place, path, hunk, from: i, to: i, drag: false }));
  requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>(".diff-comment textarea")?.focus({ preventScroll: true }));
  return true;
}

export function Counts({ added, deleted }: { added: number; deleted: number }) {
  return <span className="diff-counts"><span className="diff-added">+{added}</span><span className="diff-deleted">−{deleted}</span></span>;
}

export const Changes = observer(function Changes({ steps }: { steps: StepDiff[] | null }) {
  if (!steps) return <p className="convo-empty">Reading the changes…</p>;
  if (!steps.length) return <p className="convo-empty">No step has sent its commit yet.</p>;
  const last = steps[steps.length - 1].place;
  return (
    <div className="changes">
      <p className="changes-hint">Click a line’s number to comment on it, or drag along the numbers for a range; <kbd>C</kbd> picks the line you point at.</p>
      {steps.map((s) => <StepCard key={s.place} s={s} open={s.place === last} />)}
    </div>
  );
});

// A step's card: its place, title and note, how much it changed, then its files. The latest step starts open, as the
// one to look at before saying "next".
const StepCard = observer(function StepCard({ s, open: first }: { s: StepDiff; open: boolean }) {
  const [open, setOpen] = useState(first);
  const card = useRef<HTMLElement>(null);
  const asked = wanted.get()?.place === s.place;
  useEffect(() => {
    if (!asked) return;
    setOpen(true);
    card.current?.scrollIntoView({ block: "start" });
    runInAction(() => wanted.set(null));
  }, [asked]);
  return (
    <section ref={card} className={`change-step${open ? " open" : ""}`} data-place={s.place}>
      <button type="button" className="change-step-head" aria-expanded={open} onClick={() => setOpen(!open)}
        title={`${open ? "Fold" : "Open"} step ${s.place}, ${s.commit.slice(0, 7)}`}>
        <span className="change-fold">{TRIANGLE}</span>
        <StateIcon state={s.state} />
        <span className="change-place">{s.place}</span>
        <span className="change-title">{s.title}</span>
        {s.note && <span className="change-note">{s.note}</span>}
        <span className="change-files">{s.files.length} {s.files.length === 1 ? "file" : "files"}</span>
        <Counts added={s.added} deleted={s.deleted} />
      </button>
      {open && s.files.map((f) => <FileCard key={f.path} f={f} place={s.place} />)}
    </section>
  );
});

const FileCard = observer(function FileCard({ f, place }: { f: FileDiff; place: string }) {
  const [open, setOpen] = useState(f.added + f.deleted <= OPEN_LINES);
  const slash = f.path.lastIndexOf("/");
  const p = picked.get(), mine = p && p.place === place && p.path === f.path ? p : null;
  return (
    <div className="change-file" data-path={f.path}>
      <button type="button" className="change-file-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="change-fold">{TRIANGLE}</span>
        <span className="change-file-name">{f.path.slice(slash + 1)}</span>
        <span className="change-file-dir">{f.was ? `from ${f.was}` : f.path.slice(0, slash + 1)}</span>
        <Counts added={f.added} deleted={f.deleted} />
      </button>
      {open && (f.binary ? <p className="change-quiet">A binary file: no lines to show.</p>
        : !f.hunks.length ? <p className="change-quiet">{f.was ? "Moved, unchanged." : "No lines changed."}</p>
        : (
          <table className="diff" onMouseDown={(e) => pickDown(e, f.path)} onMouseOver={(e) => pickOver(e, f.path)}>
            <colgroup><col className="diff-no-col" /><col /></colgroup>
            <tbody>
              {f.hunks.map((h, n) => {
                const lit: [number, number] | null = mine?.hunk === n ? [Math.min(mine.from, mine.to), Math.max(mine.from, mine.to)] : null;
                return (
                  <Hunk key={n} n={n} header={h.header} lines={h.lines} lit={lit}
                    box={lit && !mine!.drag ? <CommentBox quote={quoted(place, f.path, h.lines.slice(lit[0], lit[1] + 1))} /> : null} />
                );
              })}
            </tbody>
          </table>
        ))}
      {open && f.cut && <p className="change-quiet">The rest of this file is cut: it changed too many lines to draw.</p>}
    </div>
  );
});

// A hunk's lines, the picked ones lit, and the box under the last of them once the mouse lets go.
function Hunk({ n: hunk, header, lines, lit, box }: { n: number; header: string; lines: Line[]; lit: [number, number] | null; box: React.ReactNode }) {
  return (
    <>
      <tr className="diff-hunk"><td colSpan={2}>{header || " "}</td></tr>
      {lines.map(([kind, old, now, text], i) => (
        <Fragment key={i}>
          <tr className={`${kind === "+" ? "diff-add" : kind === "-" ? "diff-del" : ""}${lit && i >= lit[0] && i <= lit[1] ? " picked" : ""}`.trim() || undefined}
            data-no={kind === "-" ? old! : now!} data-kind={kind} data-hunk={hunk} data-i={i}>
            <td className="diff-no">{kind === "-" ? old : now}</td>
            <td className="diff-code">{text || " "}</td>
          </tr>
          {i === lit?.[1] && box}
        </Fragment>
      ))}
    </>
  );
}

// The box under the picked lines: desk's own reply box, where GitHub opens its comment box (the user's pick of three
// mockups, 28 Oct). Its send puts the lines, quoted, and the words under them into the chat in the middle, to the
// issue's session, as any message: "whatever i comment in the code, i'll get a reply in the same chat" (28 Oct).
const CommentBox = observer(function CommentBox({ quote }: { quote: string }) {
  const box = useRef<HTMLTextAreaElement>(null);
  useEffect(() => box.current?.focus({ preventScroll: true }), []);
  const text = words.get();
  async function send() {
    if (!text.trim() || !dock.session) return;
    if (!(await live(dock.session).send(quote + text.trim(), []))) return;
    dropPick();
    toast("Sent to the chat");
  }
  return (
    <tr className="diff-comment">
      <td colSpan={2}>
        <div className="composer diff-comment-box">
          <div className="composer-text">
            <textarea ref={box} rows={1} spellCheck={false} placeholder="Leave a comment…" value={text}
              onChange={(e) => runInAction(() => words.set(e.target.value))}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); }
                else if (e.key === "Escape") { e.stopPropagation(); dropPick(); } // before Frame's Esc, which only leaves the box
              }} />
          </div>
          <div className="composer-foot">
            <span className="spacer" />
            <button className="send" type="button" title="Send  Enter" disabled={!text.trim()} onClick={() => void send()}>
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M8 13V3M3.5 7.5L8 3l4.5 4.5" /></svg>
            </button>
          </div>
        </div>
      </td>
    </tr>
  );
});
