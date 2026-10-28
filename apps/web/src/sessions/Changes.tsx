// An issue's Changes, the tab beside its chat: a card per build step, holding the step's diff from the commit its
// session sent as it ticked the step (changes.ts). "we have diff show while coding, allowing user to catches the
// problem early" (the user, 28 Oct). The lines are drawn as Linear Diffs draws them, measured on the demo on
// linear.app's Reviews page on 28 Oct: one number column, a tinted line with a coloured edge for what was added or
// deleted, and the counts in green and red.
import { observable, runInAction } from "mobx";
import { observer } from "mobx-react-lite";
import { useEffect, useRef, useState } from "react";
import { usePage } from "../api/page";
import type { PlanStep } from "../issues/Steps";
import { dock } from "../store/dock";
import { StateIcon, TRIANGLE } from "../ui/icons";
import { toast } from "../ui/toast";
import { toggleIssue } from "./Dock";

type Line = [kind: " " | "+" | "-", old: number | null, now: number | null, text: string];
type FileDiff = { path: string; was?: string; added: number; deleted: number; binary?: true; cut?: true; hunks: { header: string; lines: Line[] }[] };
export type StepDiff = { place: string; title: string; state: PlanStep["state"]; note?: string; commit: string; added: number; deleted: number; files: FileDiff[] };

// A file with more changed lines than this starts folded, so one big file doesn't bury the rest.
const OPEN_LINES = 400;

export const useChanges = (slug: string) => usePage<{ steps: StepDiff[] }>(`/api/page/issue/${slug}/changes`).data?.steps ?? null;

// Whether any of the steps carries a commit, so has a diff to show.
export const anyCommit = (steps: (PlanStep & { commit?: string })[] | null | undefined): boolean =>
  Boolean(steps?.some((s) => s.commit || anyCommit(s.kids)));

// A step to show in its chat's Changes, asked for by a click on its counts in the steps beside the chat (Steps.tsx):
// the chat turns to Changes, and that step's card opens and comes into view.
export const wanted = observable.box<{ slug: string; place: string } | null>(null, { deep: false });
// On a phone the steps lie over the chat, so they step aside for it.
export function showChanges(slug: string, place: string) {
  runInAction(() => wanted.set({ slug, place }));
  if (dock.narrow && dock.sideShown) toggleIssue();
}

// Lines quoted from a diff for the reply box of the chat in the middle (Dock.tsx, Composer), which takes them in.
export const quote = observable.box<{ session: string; text: string } | null>(null, { deep: false });

// C on a line of a diff, or on lines selected in one, quotes them into the chat's reply box, with their step, file and
// line numbers, for you to write under: "whatever i comment in the code, i'll get a reply in the same chat" (the user,
// 28 Oct). Anywhere else C files a new issue (Frame.tsx).
export function quoteLines(): boolean {
  const rowOf = (n: Node | null | undefined) =>
    (n instanceof Element ? n : n?.parentElement)?.closest<HTMLTableRowElement>(".changes table.diff tr[data-no]") ?? null;
  const sel = getSelection();
  let first = sel && !sel.isCollapsed ? rowOf(sel.anchorNode) : null, last = sel && first ? rowOf(sel.focusNode) : null;
  if (!first || !last || first.parentElement !== last.parentElement)
    first = last = document.querySelector<HTMLTableRowElement>(".changes table.diff tr[data-no]:hover");
  // C over Changes but off its lines says what it wants rather than filing a new issue.
  if (!first || !last) return Boolean(document.querySelector(".changes:hover") && (toast("Point at a line, or select lines, to quote them"), true));
  if (!dock.session) return false;
  if (first.compareDocumentPosition(last) & Node.DOCUMENT_POSITION_PRECEDING) [first, last] = [last, first];
  const rows: HTMLTableRowElement[] = [];
  for (let r: Element | null = first; r; r = r.nextElementSibling) {
    if (r.matches("tr[data-no]")) rows.push(r as HTMLTableRowElement);
    if (r === last) break;
  }
  const path = first.closest<HTMLElement>("[data-path]")!.dataset.path!, place = first.closest<HTMLElement>("[data-place]")!.dataset.place!;
  const [from, to] = [rows[0].dataset.no, rows[rows.length - 1].dataset.no];
  const lines = rows.map((r) => `${r.dataset.kind}${r.querySelector(".diff-code")!.textContent!.replace(/^ $/, "")}`);
  const text = `Step ${place}, ${path}:${from === to ? from : `${from}-${to}`}\n\`\`\`diff\n${lines.join("\n")}\n\`\`\`\n`;
  runInAction(() => quote.set({ session: dock.session!, text }));
  sel?.removeAllRanges();
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
      <p className="changes-hint"><kbd>C</kbd> on a line, or on lines you select, quotes them into the reply box below.</p>
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
      {open && s.files.map((f) => <FileCard key={f.path} f={f} />)}
    </section>
  );
});

function FileCard({ f }: { f: FileDiff }) {
  const [open, setOpen] = useState(f.added + f.deleted <= OPEN_LINES);
  const slash = f.path.lastIndexOf("/");
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
          <table className="diff">
            <colgroup><col className="diff-no-col" /><col /></colgroup>
            <tbody>
              {f.hunks.map((h, n) => <Hunk key={n} header={h.header} lines={h.lines} />)}
            </tbody>
          </table>
        ))}
      {open && f.cut && <p className="change-quiet">The rest of this file is cut: it changed too many lines to draw.</p>}
    </div>
  );
}

function Hunk({ header, lines }: { header: string; lines: Line[] }) {
  return (
    <>
      <tr className="diff-hunk"><td colSpan={2}>{header || " "}</td></tr>
      {lines.map(([kind, old, now, text], n) => (
        <tr key={n} className={kind === "+" ? "diff-add" : kind === "-" ? "diff-del" : undefined} data-no={kind === "-" ? old! : now!} data-kind={kind}>
          <td className="diff-no">{kind === "-" ? old : now}</td>
          <td className="diff-code">{text || " "}</td>
        </tr>
      ))}
    </>
  );
}
