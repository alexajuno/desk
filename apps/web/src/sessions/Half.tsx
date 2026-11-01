// The right half beside the chat in the middle, which holds what Claude drives (store/dock.ts): the chat's terminal
// (Terminal.tsx) or its browser (Browser.tsx), each a view of it. It runs the window's full height beside the chat,
// half its width at first, and its left edge drags to resize it. It has no head of its own: the terminal and globe
// buttons in the chat's head, Ctrl ` and Ctrl ⇧ B open it on their view, switch it to theirs, and hide it ("we have two
// duplicated sections: the terminal and browser icons and then, on right sidebar, we have terminal and browser chips",
// the user, 1 Nov, then "yeah A" on two mockups, over the half's tabs with one button in the head). Hiding leaves the
// terminal's session running. On a phone it takes the chat's place, under the chat's head.
import { observer } from "mobx-react-lite";
import { useCallback, type PointerEvent, type ReactNode } from "react";
import { dock, type Half as View } from "../store/dock";
import { toast } from "../ui/toast";
import { live } from "./live";
import { BrowserView } from "./Browser";
import { TerminalView } from "./Terminal";

// Each view the half can show: its name and what draws it.
const VIEWS: Record<View, { label: string; draw: (session: string, hide: () => void) => ReactNode }> = {
  terminal: { label: "Terminal", draw: (session, hide) => <TerminalView session={session} ended={hide} /> },
  browser: { label: "Browser", draw: (session) => <BrowserView session={session} /> },
};

export const Half = observer(function Half({ session, view }: { session: string; view: View }) {
  const hide = useCallback(() => dock.setHalf(session, null), [session]);
  return (
    <section className="half" style={{ width: `${dock.halfWidth * 100}%` }} aria-label={VIEWS[view].label}>
      <div className="half-grip" onPointerDown={drag} title="Drag to resize" />
      {VIEWS[view].draw(session, hide)}
    </section>
  );
});

// Dragging the half's left edge: its share of the chat's width follows the pointer.
function drag(e: PointerEvent<HTMLDivElement>) {
  const grip = e.currentTarget, whole = grip.closest(".session-split")!.getBoundingClientRect();
  grip.setPointerCapture(e.pointerId);
  document.documentElement.classList.add("half-dragging");
  const move = (m: globalThis.PointerEvent) => dock.setHalfWidth((whole.right - m.clientX) / whole.width);
  const end = () => {
    grip.removeEventListener("pointermove", move);
    document.documentElement.classList.remove("half-dragging");
  };
  grip.addEventListener("pointermove", move);
  grip.addEventListener("lostpointercapture", end, { once: true });
  e.preventDefault();
}

// Ctrl `, as VS Code's, and Ctrl ⇧ B: the half of the chat in the middle open on its terminal or its browser, or
// hidden when it shows that one, the reply box taking the cursor back. False when no chat is there.
export function toggleHalf(view: View): boolean {
  if (!dock.center || !dock.session) return false;
  if (!live(dock.session).meta?.chat) return (toast(`Only a desk chat has a ${view}.`), true);
  const open = dock.halves[dock.session] === view;
  const inside = document.activeElement?.closest(".half");
  dock.setHalf(dock.session, open ? null : view, true);
  if (open && inside) document.querySelector<HTMLTextAreaElement>(".dock .composer textarea")?.focus();
  return true;
}
