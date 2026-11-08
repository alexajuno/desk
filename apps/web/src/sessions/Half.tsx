// The right half beside the chat in the middle (store/dock.ts), each a view of it: what Claude drives, the chat's
// terminal (Terminal.tsx), and what you read beside the chat, its issue's steps, each step's
// diagram under its row (StepsHalf.tsx), or its issue's Changes, each step's diff (Changes.tsx). It runs the window's full height beside the chat, and
// takes all the room the chat leaves, the chat a 480px column until its left edge is dragged ("ok. A", 2 Nov), so a
// wider window widens only the half. It has no head of its own: the buttons in the chat's head, and Ctrl ⇧ S, Ctrl ⇧ G
// and Ctrl `, open it on their view, switch it to theirs, and hide it ("we have two duplicated sections: the
// terminal and browser icons and then, on right sidebar, we have terminal and browser chips", the user, 1 Nov, then
// "yeah A" on two mockups, over the half's tabs with one button in the head). Hiding leaves the terminal's session
// running. Where the dock can't give the chat 480px and the half 780px, and on a phone, it takes the chat's place, under
// the chat's head, and the head's Chat button brings the chat back (frame/oneScreen.ts). Claude's tabs, the Browser, are
// the native window's alone (apps/native), as they were Electron's until 8 Nov.
import { observer } from "mobx-react-lite";
import { useCallback, type PointerEvent, type ReactNode } from "react";
import { dock, type Half as View } from "../store/dock";
import { toast } from "../ui/toast";
import { live } from "./live";
import { ChangesHalf } from "./Changes";
import { TerminalView } from "./Terminal";

// The chat's issue, for its Changes.
type Issue = { slug: string } | null;

// Each view the half can show: its name and what draws it.
const VIEWS: Record<View, { label: string; draw: (session: string, hide: () => void, issue: Issue, list: ReactNode) => ReactNode }> = {
  terminal: { label: "Terminal", draw: (session, hide) => <TerminalView session={session} ended={hide} /> },
  steps: { label: "Steps", draw: (_, __, ___, list) => list },
  changes: { label: "Changes", draw: (_, __, issue) => issue && <ChangesHalf slug={issue.slug} /> },
};

// list: the issue's steps as Dock.tsx draws them, which alone knows where each was sent in the chat.
export const Half = observer(function Half({ session, view, issue = null, list = null }: { session: string; view: View; issue?: Issue; list?: ReactNode }) {
  const hide = useCallback(() => dock.setHalf(session, null), [session]);
  return (
    <section className="half" aria-label={VIEWS[view].label}>
      <div className="half-grip" onPointerDown={drag} title="Drag to resize" />
      {VIEWS[view].draw(session, hide, issue, list)}
    </section>
  );
});

// Dragging the half's left edge: the chat ends where the pointer is, leaving the half at least its min-width (dock.css).
function drag(e: PointerEvent<HTMLDivElement>) {
  const grip = e.currentTarget, whole = grip.closest(".session-split")!.getBoundingClientRect();
  const most = whole.width - parseFloat(getComputedStyle(grip.parentElement!).minWidth);
  grip.setPointerCapture(e.pointerId);
  document.documentElement.classList.add("half-dragging");
  const move = (m: globalThis.PointerEvent) => dock.setChatWidth(Math.min(most, m.clientX - whole.left));
  const end = () => {
    grip.removeEventListener("pointermove", move);
    document.documentElement.classList.remove("half-dragging");
  };
  grip.addEventListener("pointermove", move);
  grip.addEventListener("lostpointercapture", end, { once: true });
  e.preventDefault();
}

// Ctrl `, as VS Code's, Ctrl ⇧ S and Ctrl ⇧ G, VS Code's for its changes: the half of the chat in the middle open on its
// terminal, its issue's steps or its Changes, or hidden when it shows that one, the reply box taking the cursor back.
// False when no chat is there, and for the steps and the Changes where their button is not in the chat's head (Dock.tsx), so that the key goes on
// to your browser.
export function toggleHalf(view: View): boolean {
  if (!dock.center || !dock.session) return false;
  if ((view === "steps" || view === "changes") && !document.querySelector(`.dock .half-btn.half-${view}`)) return false;
  if (!live(dock.session).meta?.chat) return (toast(`Only a desk chat has a ${view}.`), true);
  const open = dock.halves[dock.session] === view;
  const inside = document.activeElement?.closest(".half");
  dock.setHalf(dock.session, open ? null : view, true);
  if (open && inside) document.querySelector<HTMLTextAreaElement>(".dock .composer textarea")?.focus();
  return true;
}

// Ctrl ⇧ L, the head's Chat button: hides the half, so that the chat shows again and the reply box takes the cursor.
// False where no half is open, so that the key goes on to your browser.
export function showChat(): boolean {
  if (!dock.center || !dock.session || !dock.halves[dock.session]) return false;
  dock.setHalf(dock.session, null, true);
  document.querySelector<HTMLTextAreaElement>(".dock .composer textarea")?.focus();
  return true;
}
