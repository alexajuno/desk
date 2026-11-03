// An issue's Changes, a view of the right half beside its chat (Half.tsx): a card per build step, holding the step's
// diff from the commit its session sent as it ticked the step (changes.ts). Until 4 Nov it took the chat's place, on a
// tab in the chat's head, so that reading a diff hid the chat explaining it ("wanna bring the changes tab to the right
// sidebar similar to diagrams and browser and all other things", the user, 4 Nov). "we have diff show while coding, allowing user to catches the
// problem early" (the user, 28 Oct). The lines are drawn as Linear Diffs draws them, measured on the demo on
// linear.app's Reviews page on 28 Oct: one number column, a tinted line with a coloured edge for what was added or
// deleted, and the counts in green and red.
import { compareStructural, observable, reaction, runInAction } from "mobx";
import { observer } from "mobx-react-lite";
import { Fragment, useEffect, useRef, useState } from "react";
import { usePage } from "../api/page";
import type { PlanStep } from "../issues/Steps";
import { dock } from "../store/dock";
import { GLYPH, StateIcon, TRIANGLE } from "../ui/icons";
import { toast } from "../ui/toast";
import { live } from "./live";

type Line = [kind: " " | "+" | "-", old: number | null, now: number | null, text: string];
// A file's length is how many lines it has at the step's commit (changes.ts), there when its hidden lines can open.
type FileDiff = { path: string; was?: string; added: number; deleted: number; binary?: true; cut?: true; length?: number; hunks: { header: string; lines: Line[] }[] };
export type StepDiff = { place: string; title: string; state: PlanStep["state"]; note?: string; commit: string; added: number; deleted: number; files: FileDiff[] };

// A file with more changed lines than this starts folded, so one big file doesn't bury the rest.
const OPEN_LINES = 400;
// How many hidden lines an arrow opens, as GitHub's do: the hunk you read stays in view.
const MORE_LINES = 20;
// Whole file draws a file at once only up to this many lines; a longer one opens 20 at a time. desk's longest file,
// pnpm-lock.yaml, has 3,799 (step 1.3, 4 Nov).
const WHOLE_LINES = 5000;

export const useChanges = (slug: string) => usePage<{ steps: StepDiff[] }>(`/api/page/issue/${slug}/changes`).data?.steps ?? null;

// Whether any of the steps carries a commit, so has a diff to show.
export const anyCommit = (steps: (PlanStep & { commit?: string })[] | null | undefined): boolean =>
  Boolean(steps?.some((s) => s.commit || anyCommit(s.kids)));

// The commit of the last step in the list that carries one: the newest step's diff.
export const lastCommit = (steps: (PlanStep & { commit?: string })[] | null | undefined): string | null =>
  (steps ?? []).reduce<string | null>((last, s) => lastCommit(s.kids) ?? s.commit ?? last, null);

// Lines picked in a step's diff to comment on, as GitHub's + picks them: a click on a line's number picks the line, and
// a drag along the numbers or a shift-click picks a range ("line selection effect similar to github's", the user, 28
// Oct), the hunks' lines and those opened round them alike, inside the stretch of lines you can see that it started in:
// a row that still hides lines ends it (step 1.3, 4 Nov). from is the line where the pick started and to where it ends,
// either way round, by their keys (Row), so the pick stays on its lines while more open round it; drag holds while the
// mouse is down.
type Picked = { place: string; path: string; from: string; to: string; drag: boolean };
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

const rowAt = (target: EventTarget) => (target as Element).closest<HTMLTableRowElement>("tr[data-key]");
// Whether a line's row is in the same stretch of lines as the line a pick started on, in the same file's table.
const besides = (row: HTMLTableRowElement, from: string) =>
  row.closest("table")!.querySelector<HTMLElement>(`tr[data-key="${from}"]`)?.dataset.stretch === row.dataset.stretch;

// Where the mouse went down to pick. The box under the old pick goes as it does, and the rows under the mouse move up
// with it: the browser says the mouse is over another row though it has not moved, which grew a click into a pick of
// six lines (found on the test desk, 4 Nov). Only a mouse that moved drags.
let downAt = "";

function pickDown(e: React.MouseEvent, path: string) {
  const row = rowAt(e.target);
  if (e.button !== 0 || !row || !(e.target as Element).closest(".diff-no")) return;
  e.preventDefault(); // no text selection from the numbers
  downAt = `${e.clientX},${e.clientY}`;
  const place = row.closest<HTMLElement>("[data-place]")!.dataset.place!, key = row.dataset.key!;
  const p = picked.get();
  const extend = e.shiftKey && p && p.place === place && p.path === path && besides(row, p.from);
  runInAction(() => picked.set(extend ? { ...p, to: key, drag: true } : { place, path, from: key, to: key, drag: true }));
  addEventListener("mouseup", () => runInAction(() => { const q = picked.get(); if (q) picked.set({ ...q, drag: false }); }), { once: true });
}

function pickOver(e: React.MouseEvent, path: string) {
  const p = picked.get(), row = rowAt(e.target);
  if (!p?.drag || !row || `${e.clientX},${e.clientY}` === downAt || p.path !== path || row.closest<HTMLElement>("[data-place]")!.dataset.place !== p.place || !besides(row, p.from)) return;
  if (row.dataset.key !== p.to) runInAction(() => picked.set({ ...p, to: row.dataset.key! }));
}

// C on a line of a diff picks it and opens the box under it, as a click on its number does; on a line already picked it
// goes back into the box. Over Changes but off its lines it says how, rather than filing a new issue, which C does
// elsewhere (Frame.tsx). Selecting the code's text only copies it.
export function commentKey(): boolean {
  const row = document.querySelector<HTMLTableRowElement>(".changes table.diff tr[data-key]:hover");
  if (!row) return Boolean(document.querySelector(".changes:hover") && (toast("Point at a line to comment on it, or click its number"), true));
  const place = row.closest<HTMLElement>("[data-place]")!.dataset.place!, path = row.closest<HTMLElement>("[data-path]")!.dataset.path!;
  const key = row.dataset.key!;
  if (!row.classList.contains("picked")) runInAction(() => picked.set({ place, path, from: key, to: key, drag: false }));
  requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>(".diff-comment textarea")?.focus({ preventScroll: true }));
  return true;
}

export function Counts({ added, deleted }: { added: number; deleted: number }) {
  return <span className="diff-counts"><span className="diff-added">+{added}</span><span className="diff-deleted">−{deleted}</span></span>;
}

// The half on the Changes: a head line level with the chat's, as the diagram's (StepHalf.tsx), saying how much the
// steps changed, which the Changes tab carried until 4 Nov, then the steps' cards, scrolling under it.
export const ChangesHalf = observer(function ChangesHalf({ slug }: { slug: string }) {
  const steps = useChanges(slug);
  const sum = (key: "added" | "deleted") => (steps ?? []).reduce((n, st) => n + st[key], 0);
  const files = new Set(steps?.flatMap((st) => st.files.map((f) => f.path))).size;
  return (
    <div className="changes-half">
      <div className="changes-half-head">
        <span className="changes-half-name">Changes</span>
        {steps && steps.length > 0 && (
          <span className="changes-half-at">
            {steps.length} {steps.length === 1 ? "step" : "steps"} · {files} {files === 1 ? "file" : "files"}
            <Counts added={sum("added")} deleted={sum("deleted")} />
          </span>
        )}
      </div>
      <div className="changes-half-scroll"><Changes slug={slug} steps={steps} /></div>
    </div>
  );
});

export const Changes = observer(function Changes({ slug, steps }: { slug: string; steps: StepDiff[] | null }) {
  if (!steps) return <p className="convo-empty">Reading the changes…</p>;
  if (!steps.length) return <p className="convo-empty">No step has sent its commit yet.</p>;
  const last = steps[steps.length - 1].place;
  return (
    <div className="changes">
      <p className="changes-hint">Click a line’s number to comment on it, or drag along the numbers for a range; <kbd>C</kbd> picks the line you point at.</p>
      {steps.map((s) => <StepCard key={s.place} slug={slug} s={s} open={s.place === last} />)}
    </div>
  );
});

// A step's card: its place, title and note, how much it changed, then its files. The latest step starts open, as the
// one to look at before saying "next".
const StepCard = observer(function StepCard({ slug, s, open: first }: { slug: string; s: StepDiff; open: boolean }) {
  const [open, setOpen] = useState(first);
  return (
    <section className={`change-step${open ? " open" : ""}`} data-place={s.place}>
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
      {open && s.files.map((f) => <FileCard key={f.path} f={f} place={s.place} at={{ slug, commit: s.commit, path: f.path }} />)}
    </section>
  );
});

const FileCard = observer(function FileCard({ f, place, at }: { f: FileDiff; place: string; at: FileAt }) {
  const [open, setOpen] = useState(f.added + f.deleted <= OPEN_LINES);
  const runs = f.length && !f.cut ? hiddenRuns(f, f.length) : null; // none to open with no length, or past the cut
  // Whole file, on a file that hides lines and is short enough to draw at once: lit while none is hidden, by it or by
  // the arrows, and pressed then it folds the file back to its changes alone.
  const canWhole = Boolean(runs && f.length! <= WHOLE_LINES && runs.some((r) => r.to >= r.from));
  const whole = canWhole && hiddenLeft(at, runs!) === 0;
  const slash = f.path.lastIndexOf("/");
  const rows = rowsOf(f, at, runs);
  const p = picked.get(), lit = p && p.place === place && p.path === f.path ? litOf(p, rows) : null;
  return (
    <div className="change-file" data-path={f.path}>
      <div className="change-file-head">
        <button type="button" className="change-file-fold" aria-expanded={open} onClick={() => setOpen(!open)}>
          <span className="change-fold">{TRIANGLE}</span>
          <span className="change-file-name">{f.path.slice(slash + 1)}</span>
          <span className="change-file-dir">{f.was ? `from ${f.was}` : f.path.slice(0, slash + 1)}</span>
          <Counts added={f.added} deleted={f.deleted} />
        </button>
        {canWhole && (
          <button type="button" className={`change-whole${whole ? " on" : ""}`} aria-pressed={whole}
            title={whole ? "Changes only" : "Whole file"} onClick={() => { setOpen(true); if (whole) foldBack(at); else void openWhole(at, runs!); }}>
            {GLYPH.wholeFile}
          </button>
        )}
      </div>
      {open && (f.binary ? <p className="change-quiet">A binary file: no lines to show.</p>
        : !f.hunks.length && !whole ? <p className="change-quiet">{f.was ? "Moved, unchanged." : "No lines changed."}</p>
        : (
          <table className="diff" onMouseDown={(e) => pickDown(e, f.path)} onMouseOver={(e) => pickOver(e, f.path)}>
            <colgroup><col className="diff-no-col" /><col /></colgroup>
            <tbody>
              {rows.map((r, n) => r.t === "gap" ? <Gap key={r.key} at={at} k={r.k} last={r.last} left={r.left} header={r.header} />
                : r.t === "head" ? <tr key={r.key} className="diff-hunk"><td colSpan={2}>{r.header || " "}</td></tr>
                : (
                  <Fragment key={r.key}>
                    <LineRow r={r} picked={Boolean(lit && n >= lit[0] && n <= lit[1])} />
                    {lit && n === lit[1] && !p!.drag && <CommentBox quote={quoted(place, f.path, rows.slice(lit[0], lit[1] + 1).flatMap((l) => (l.t === "line" ? [l.line] : [])))} />}
                  </Fragment>
                ))}
            </tbody>
          </table>
        ))}
      {open && f.cut && <p className="change-quiet">The rest of this file is cut: it changed too many lines to draw.</p>}
    </div>
  );
});

// Where a file of a step's diff is read: the issue, the step's commit and the file's path.
type FileAt = { slug: string; commit: string; path: string };
const fileKey = ({ slug, commit, path }: FileAt) => `${slug}\0${commit}\0${path}`;

// The runs of lines a file's hunks leave out, in the file's numbers at the step's commit: one above each hunk, then one
// under the last, down to the file's end. A run can be empty, as above a hunk that starts on line 1.
type Run = { from: number; to: number };
function hiddenRuns(f: FileDiff, length: number): Run[] {
  const runs: Run[] = [];
  let end = 0;
  for (const h of f.hunks) {
    const nows = h.lines.flatMap(([, , now]) => (now === null ? [] : [now]));
    runs.push({ from: end + 1, to: (nows[0] ?? end + 1) - 1 });
    end = nows[nows.length - 1] ?? end;
  }
  runs.push({ from: end + 1, to: length });
  return runs;
}

// A file as the step's commit left it, read the first time one of its hidden lines opens (changes.ts, fileAt), and what
// is open of each of its runs: so many lines from the run's top, under the hunk above, and from its bottom, over the hunk
// below. Both stay while the chat does, through a step folded and opened again, and go when you leave it, so each visit
// starts on the changes alone.
type Opened = { top: number; bottom: number };
const read = observable.map<string, string[]>({}, { deep: false });
const opened = observable.map<string, Opened[]>({}, { deep: false });
const asking = new Map<string, Promise<string[] | null>>();
reaction(() => [dock.session, dock.center], () => runInAction(() => { read.clear(); opened.clear(); }), { equals: compareStructural });

function readFile(at: FileAt): Promise<string[] | null> {
  const key = fileKey(at), had = read.get(key);
  if (had) return Promise.resolve(had);
  let got = asking.get(key);
  if (!got) {
    got = fetch(`/api/page/issue/${at.slug}/changes/file?commit=${encodeURIComponent(at.commit)}&path=${encodeURIComponent(at.path)}`, { cache: "no-store" })
      .then(async (r) => {
        const body = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(body.detail ?? `desk answered ${r.status}`);
        return (body as { lines: string[] }).lines;
      })
      .then((lines) => { runInAction(() => read.set(key, lines)); return lines; },
        (e: Error) => { toast(`Could not read ${at.path}: ${e.message}`); return null; })
      .finally(() => asking.delete(key));
    asking.set(key, got);
  }
  return got;
}

async function openRun(at: FileAt, k: number, more: Partial<Opened>) {
  if (!(await readFile(at))) return;
  const key = fileKey(at);
  runInAction(() => {
    const all = [...(opened.get(key) ?? [])], was = all[k] ?? { top: 0, bottom: 0 };
    all[k] = { top: was.top + (more.top ?? 0), bottom: was.bottom + (more.bottom ?? 0) };
    opened.set(key, all);
  });
}

// How many of a file's lines its runs still hide: all of them until the file is read.
function hiddenLeft(at: FileAt, runs: Run[]): number {
  const o = read.get(fileKey(at)) && opened.get(fileKey(at));
  return runs.reduce((n, r, k) => n + Math.max(0, r.to - r.from + 1 - (o?.[k] ? o[k].top + o[k].bottom : 0)), 0);
}

// Whole file opens every run at once; pressed again it folds them all back, the ones the arrows opened too.
async function openWhole(at: FileAt, runs: Run[]) {
  if (!(await readFile(at))) return;
  runInAction(() => opened.set(fileKey(at), runs.map((r) => ({ top: Math.max(0, r.to - r.from + 1), bottom: 0 }))));
}

function foldBack(at: FileAt) {
  runInAction(() => opened.delete(fileKey(at)));
}

// What a file's table draws, top to bottom: its lines, the hunks' and those opened round them, and between them the rows
// that still hide lines (Gap), or, where none can open, each hunk's dim row holding the function it is in. Each line has
// a key that stays while more lines open round it, its hunk's place in the diff or its number in the file once opened,
// and the stretch of lines it is in, which a row between ends: a pick stays inside one.
type LineAt = { t: "line"; key: string; line: Line; stretch: number; open: boolean };
type Row = LineAt | { t: "gap"; key: string; k: number; last: boolean; left: number; header: string } | { t: "head"; key: string; header: string };

function rowsOf(f: FileDiff, at: FileAt, runs: Run[] | null): Row[] {
  const rows: Row[] = [], lines = read.get(fileKey(at)), o = lines ? opened.get(fileKey(at)) : undefined;
  let stretch = 0;
  // An opened line reads as the unchanged lines round it, and is quoted as one, by its number in the file.
  const shown = (from: number, to: number) => {
    for (let n = from; n <= to; n++) rows.push({ t: "line", key: `o${n}`, line: [" ", null, n, lines![n - 1] ?? ""], stretch, open: true });
  };
  const hidden = (k: number, header: string) => {
    const r = runs![k], size = r.to - r.from + 1;
    if (size <= 0) return;
    const top = Math.min(o?.[k]?.top ?? 0, size), bottom = Math.min(o?.[k]?.bottom ?? 0, size - top), left = size - top - bottom;
    shown(r.from, r.from + top - 1);
    if (left > 0) {
      rows.push({ t: "gap", key: `g${k}`, k, last: k === runs!.length - 1, left, header });
      stretch++;
    }
    shown(r.to - bottom + 1, r.to);
  };
  f.hunks.forEach((h, n) => {
    if (runs) hidden(n, h.header);
    else {
      rows.push({ t: "head", key: `d${n}`, header: h.header });
      stretch++;
    }
    h.lines.forEach((line, i) => rows.push({ t: "line", key: `h${n}.${i}`, line, stretch, open: false }));
  });
  if (runs) hidden(runs.length - 1, "");
  return rows;
}

// Where a pick lies in its file's rows, its first and last line, while both show in one stretch of lines: none once
// Whole file folds back the lines it ran across.
function litOf(p: Picked, rows: Row[]): [number, number] | null {
  const a = rows.findIndex((r) => r.key === p.from), b = rows.findIndex((r) => r.key === p.to);
  if (a < 0 || b < 0 || (rows[a] as LineAt).stretch !== (rows[b] as LineAt).stretch) return null;
  return [Math.min(a, b), Math.max(a, b)];
}

// A row of hidden lines, opened as GitHub opens them (step 1.3 of the issue "Read code inside desk", 4 Nov: "how about
// nav between code and expand the code"): arrows in the number column, the function the hunk below is in, and how many
// lines it hides. ↓ opens 20 under the hunk above, ↑ 20 over the hunk below, and ↕ the rest once 20 or fewer are left;
// above the first hunk there is only ↑, under the last only ↓. Once none is hidden the row goes, and the hunks round it
// read as one stretch of lines.
function Gap({ at, k, last, left, header }: { at: FileAt; k: number; last: boolean; left: number; header: string }) {
  const arrow = (icon: React.ReactNode, title: string, more: Partial<Opened>) => (
    <button type="button" className="diff-gap-open" title={title} onClick={() => void openRun(at, k, more)}>{icon}</button>
  );
  const lineWord = left === 1 ? "line" : "lines";
  return (
    <tr className="diff-gap">
      <td className="diff-gap-arrows">
        {left <= MORE_LINES ? arrow(GLYPH.openAll, `Show the ${left} hidden ${lineWord}`, k === 0 ? { bottom: left } : { top: left }) : (
          <>
            {k > 0 && arrow(GLYPH.openDown, `Show ${MORE_LINES} more lines down`, { top: MORE_LINES })}
            {!last && arrow(GLYPH.openUp, `Show ${MORE_LINES} more lines up`, { bottom: MORE_LINES })}
          </>
        )}
      </td>
      <td className="diff-gap-line"><span className="diff-gap-count">{left} hidden {lineWord}</span>{header}</td>
    </tr>
  );
}

// A line of the file's table, lit while picked, its key and stretch on its row for the pick's mouse (pickDown).
function LineRow({ r: { key, line: [kind, old, now, text], stretch, open }, picked }: { r: LineAt; picked: boolean }) {
  const tint = kind === "+" ? "diff-add" : kind === "-" ? "diff-del" : open ? "diff-open" : "";
  return (
    <tr className={`${tint}${picked ? " picked" : ""}`.trim() || undefined} data-key={key} data-stretch={stretch} data-no={kind === "-" ? old! : now!} data-kind={kind}>
      <td className="diff-no">{kind === "-" ? old : now}</td>
      <td className="diff-code">{text || " "}</td>
    </tr>
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
