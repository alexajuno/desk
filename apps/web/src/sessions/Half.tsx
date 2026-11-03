// The right half beside the chat in the middle, which holds what Claude drives (store/dock.ts): the chat's terminal
// (Terminal.tsx) or its browser (Browser.tsx), each a view of it, and the diagram of the design step part being read in
// the chat (StepHalf.tsx). It runs the window's full height beside the chat, and
// takes all the room the chat leaves, the chat a 480px column until its left edge is dragged ("ok. A", 2 Nov), so a
// wider window widens only the half. It has no head of its own: the terminal and globe buttons in the chat's head,
// Ctrl ` and Ctrl ⇧ B open it on their view, switch it to theirs, and hide it ("we have two duplicated sections: the
// terminal and browser icons and then, on right sidebar, we have terminal and browser chips", the user, 1 Nov, then
// "yeah A" on two mockups, over the half's tabs with one button in the head). Hiding leaves the terminal's session
// running. On a phone it takes the chat's place, under the chat's head. Only desk's app has the browser (lib/desktop.ts).
import { observer } from "mobx-react-lite";
import { useCallback, type PointerEvent, type ReactNode } from "react";
import { APP } from "../lib/desktop";
import { dock, type Half as View } from "../store/dock";
import { toast } from "../ui/toast";
import { live } from "./live";
import { BrowserView } from "./Browser";
import { StepHalf } from "./StepHalf";
import { TerminalView } from "./Terminal";
import type { PlanStep } from "../issues/Steps";

// Each view the half can show: its name and what draws it, from the chat's issue's steps for a step's diagram.
const VIEWS: Record<View, { label: string; draw: (session: string, hide: () => void, steps: PlanStep[]) => ReactNode }> = {
  terminal: { label: "Terminal", draw: (session, hide) => <TerminalView session={session} ended={hide} /> },
  browser: { label: "Browser", draw: (session) => <BrowserView session={session} /> },
  step: { label: "Diagram", draw: (session, _, steps) => <StepHalf session={session} steps={steps} /> },
};

export const Half = observer(function Half({ session, view, steps = [] }: { session: string; view: View; steps?: PlanStep[] }) {
  const hide = useCallback(() => dock.setHalf(session, null), [session]);
  return (
    <section className="half" aria-label={VIEWS[view].label}>
      <div className="half-grip" onPointerDown={drag} title="Drag to resize" />
      {VIEWS[view].draw(session, hide, steps)}
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

// Ctrl `, as VS Code's, Ctrl ⇧ B and Ctrl ⇧ D: the half of the chat in the middle open on its terminal, its browser or
// its step's diagrams, or hidden when it shows that one, the reply box taking the cursor back. False when no chat is
// there, for the browser in a web page, which has none (lib/desktop.ts), and for the diagram where its button is not
// in the chat's head (Dock.tsx), so that the key goes on to your browser.
export function toggleHalf(view: View): boolean {
  if (!dock.center || !dock.session || (view === "browser" && !APP)) return false;
  if (view === "step" && !document.querySelector(".dock .half-btn.half-step")) return false;
  if (!live(dock.session).meta?.chat) return (toast(`Only a desk chat has a ${view}.`), true);
  const open = dock.halves[dock.session] === view;
  const inside = document.activeElement?.closest(".half");
  dock.setHalf(dock.session, open ? null : view, true);
  if (open && inside) document.querySelector<HTMLTextAreaElement>(".dock .composer textarea")?.focus();
  return true;
}
