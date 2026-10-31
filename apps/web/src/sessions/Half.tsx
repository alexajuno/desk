// The right half beside the chat in the middle, which holds what Claude drives (store/dock.ts): the chat's terminal
// (Terminal.tsx) and its browser (Browser.tsx), each a view of it, picked by the tabs in its head. It runs the window's
// full height beside the chat, half its width at first, and its left edge drags to resize it. The terminal and globe
// buttons in the reply box, Ctrl ` and Ctrl ⇧ B open it on their view and hide it; hiding leaves the terminal's session
// running. On a phone it takes the chat's place.
import { observer } from "mobx-react-lite";
import { useCallback, type PointerEvent, type ReactNode } from "react";
import { dock, type Half as View } from "../store/dock";
import { GLYPH } from "../ui/icons";
import { toast } from "../ui/toast";
import { live } from "./live";
import { BrowserView } from "./Browser";
import { TerminalView } from "./Terminal";

// Each view the half can show: its name, for its tab in the head, the key that opens or hides it, and what draws it.
const VIEWS: Record<View, { label: string; key: string; draw: (session: string, hide: () => void) => ReactNode }> = {
  terminal: { label: "Terminal", key: "Ctrl `", draw: (session, hide) => <TerminalView session={session} ended={hide} /> },
  browser: { label: "Browser", key: "Ctrl ⇧ B", draw: (session) => <BrowserView session={session} /> },
};

export const Half = observer(function Half({ session, view }: { session: string; view: View }) {
  const hide = useCallback(() => dock.setHalf(session, null), [session]);
  return (
    <section className="half" style={{ width: `${dock.halfWidth * 100}%` }} aria-label={VIEWS[view].label}>
      <div className="half-grip" onPointerDown={drag} title="Drag to resize" />
      <header className="half-head">
        <div className="dock-tabs" role="tablist">
          {(Object.keys(VIEWS) as View[]).map((v) => (
            <button key={v} className={v === view ? "here" : ""} type="button" role="tab" aria-selected={v === view}
              title={`${VIEWS[v].label}  ${VIEWS[v].key}`} onClick={() => dock.setHalf(session, v, true)}>{VIEWS[v].label}</button>
          ))}
        </div>
        <button className="dock-btn" type="button" title={`Hide  ${VIEWS[view].key}`} onClick={hide}>{GLYPH.close}</button>
      </header>
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
