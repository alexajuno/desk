// desk's toast at the bottom right of the window (desk.css .toast): what an action did, and Undo where it can be undone.
import { action, makeObservable, observableRef } from "mobx";
import { observer } from "mobx-react-lite";
import { useEffect, useLayoutEffect, useRef } from "react";

interface ToastAction {
  label: string;
  kbd?: string;
  run: () => unknown;
}

class Toasts {
  current: { text: string; action?: ToastAction; id: number } | null = null;
  private count = 0;

  constructor() {
    makeObservable(this, { current: observableRef, show: action, hide: action });
  }

  show(text: string, act?: ToastAction) {
    this.current = { text, action: act, id: ++this.count };
  }

  hide(id?: number) {
    if (id === undefined || this.current?.id === id) this.current = null;
  }
}

export const toasts = new Toasts();
export const toast = (text: string, act?: ToastAction) => toasts.show(text, act);

export const ToastHost = observer(function ToastHost() {
  const t = toasts.current;
  const ref = useRef<HTMLDivElement>(null);
  // In the corner it would cover a chat's reply box, the model chip and send at its right end, so it rises above one.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    for (const box of document.querySelectorAll(".composer")) {
      const b = box.getBoundingClientRect();
      if (b.left < r.right && r.left < b.right && b.top < r.bottom && r.top < b.bottom) el.style.bottom = `${innerHeight - b.top + 8}px`;
    }
  }, [t]);
  useEffect(() => {
    if (!t) return;
    const timer = setTimeout(() => toasts.hide(t.id), t.action ? 8000 : 3000);
    return () => clearTimeout(timer);
  }, [t]);
  if (!t) return null;
  return (
    <div className="toast" role="status" key={t.id} ref={ref}>
      <span>{t.text}</span>
      {t.action && (
        <>
          <span className="dot">·</span>
          <button className="undo" onClick={() => { toasts.hide(t.id); t.action!.run(); }}>{t.action.label}</button>
          {t.action.kbd && <kbd>{t.action.kbd}</kbd>}
        </>
      )}
    </div>
  );
});
