// The bar along the window's bottom, as VS Code's status bar (1 Nov: "a bottom status bar like vs code"): what holds for
// the whole account rather than one chat, at its right end. It shows seat's live profile by name, then that profile's
// own numbers, each after its grey word: a plan's 5-hour and Week, or api's credits left ("A", the user, 2 Nov, on
// three mockups, over every profile's numbers and one number each). desk asks the server again each minute while the
// page is shown, and the server reads seat at most each half minute (seat.ts there). A phone has no bar: its model
// menu shows them (phone.css).
import { useEffect, useState } from "react";
import { Gauge } from "../sessions/Dock";
import { resets, type Window } from "../sessions/models";
import { dollars, loadSeat, spent, type Profile, type Seat } from "./seat";

export function StatusBar() {
  const [seat, setSeat] = useState<Seat | null>(null);
  useEffect(() => {
    const load = () => {
      if (document.visibilityState === "visible") loadSeat().then(setSeat, () => {});
    };
    load();
    const every = setInterval(load, 60_000);
    document.addEventListener("visibilitychange", load);
    return () => {
      clearInterval(every);
      document.removeEventListener("visibilitychange", load);
    };
  }, []);
  const live = seat?.profiles.find((p) => p.active);
  return (
    <div className="status-bar">
      {live && (
        <span className="used">
          <button className="profile" type="button" title="Profile">
            {live.name}
            <svg viewBox="0 0 16 16" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M4.5 6.5L8 10l3.5-3.5" /></svg>
          </button>
          <Numbers p={live} />
        </span>
      )}
    </div>
  );
}

// A profile's own numbers. A meter seat could not read shows a dash, rather than leaving its word out.
function Numbers({ p }: { p: Profile }) {
  if (p.kind === "api") {
    const c = p.credits;
    if (!c) return <Gauge word="Credits" percent={0} text="–" title="Credits · seat has not counted them" />;
    return <Gauge word="Credits" percent={spent(c)} text={c.out ? "out" : `${dollars(c.budget - c.spent)} left`}
      title={c.out ? "Credits · the API said they are gone" : `Credits · $${c.spent.toFixed(2)} of ${dollars(c.budget)} spent`} />;
  }
  const limit = (word: string, w: Window | null) =>
    w ? <Gauge word={word} percent={w.percent} title={`${word} · ${w.resets ? `resets ${resets(w.resets)}` : "not started"}`} />
      : <Gauge word={word} percent={0} text="–" title={`${word} · seat has no number for it`} />;
  return <>{limit("5-hour", p.five_hour)}{limit("Week", p.week)}</>;
}
