// The bar along the window's bottom, as VS Code's status bar (1 Nov: "a bottom status bar like vs code"): what holds for
// the whole account rather than one chat, the plan's 5-hour and weekly usage, at its right end, each after its grey word
// ("so only 5hourly usage and weekly usage move to global status bar"). desk asks for them again each minute while the
// page is shown, and the server answers from what it last heard (models.ts there). A phone has no bar: its model menu
// shows them (phone.css).
import { useEffect, useState } from "react";
import { Gauge } from "../sessions/Dock";
import { loadUsage, resets, type Usage, type Window } from "../sessions/models";

export function StatusBar() {
  const [usage, setUsage] = useState<Usage | null>(null);
  useEffect(() => {
    const load = () => {
      if (document.visibilityState === "visible") loadUsage().then(setUsage, () => {});
    };
    load();
    const every = setInterval(load, 60_000);
    document.addEventListener("visibilitychange", load);
    return () => {
      clearInterval(every);
      document.removeEventListener("visibilitychange", load);
    };
  }, []);
  const limit = (word: string, w: Window | null | undefined) =>
    w && <Gauge word={word} percent={w.percent} title={`${word} · ${w.resets ? `resets ${resets(w.resets)}` : "just reset"}`} />;
  return (
    <div className="status-bar">
      <span className="used">{limit("5-hour", usage?.five_hour)}{limit("Week", usage?.seven_day)}</span>
    </div>
  );
}
