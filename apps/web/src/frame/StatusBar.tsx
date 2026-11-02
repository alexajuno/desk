// The bar along the window's bottom, as VS Code's status bar (1 Nov: "a bottom status bar like vs code"): what holds for
// the whole account rather than one chat, at its right end. It shows seat's live profile by name, then that profile's
// own numbers, each after its grey word: a plan's 5-hour and Week, or api's credits left ("A", the user, 2 Nov, on
// three mockups, over every profile's numbers and one number each). The name opens the profiles, each with its numbers,
// to make one live, and Auto switch, seat's own switching. desk asks the server again each minute while the page is
// shown, and the server reads seat at most each half minute (seat.ts there). A phone has no bar (phone.css): its model
// menu shows the live one (sessions/models.ts).
import { observer } from "mobx-react-lite";
import { useEffect } from "react";
import { Gauge } from "../sessions/Dock";
import { openMenu, toggled, type MenuItem } from "../ui/menu";
import { dollars, meters, seats, type Profile, type Window } from "./seat";

export const StatusBar = observer(function StatusBar() {
  useEffect(() => {
    const load = () => {
      if (document.visibilityState === "visible") void seats.load();
    };
    load();
    const every = setInterval(load, 60_000);
    document.addEventListener("visibilitychange", load);
    return () => {
      clearInterval(every);
      document.removeEventListener("visibilitychange", load);
    };
  }, []);
  const live = seats.seat?.profiles.find((p) => p.active);
  return (
    <div className="status-bar">
      {live && (
        <span className="used">
          <button className="profile" type="button" title="Switch profile" onClick={(e) => openProfiles(e.currentTarget)}>
            {live.name}
            <svg viewBox="0 0 16 16" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M4.5 6.5L8 10l3.5-3.5" /></svg>
          </button>
          <Numbers p={live} />
        </span>
      )}
    </div>
  );
});

// A profile's own numbers, each a ring after its grey word.
function Numbers({ p }: { p: Profile }) {
  return <>{meters(p).map((m) => <Gauge key={m.word} word={m.word} percent={m.percent} text={m.text} title={`${m.word} · ${m.about}`} />)}</>;
}

// The same numbers in a line, for a profile's row in the menu: "5-hour 67% · Week 59%", "$64 of $100 left".
function summary(p: Profile): string {
  if (p.kind === "api") {
    const c = p.credits;
    return !c ? "Credits –" : c.out ? "Credits out" : `${dollars(c.budget - c.spent)} of ${dollars(c.budget)} left`;
  }
  const limit = (word: string, w: Window | null) => `${word} ${w ? `${w.percent}%` : "–"}`;
  return `${limit("5-hour", p.five_hour)} · ${limit("Week", p.week)}`;
}

// The profiles, the live one ticked, each picked to make it live; then Auto switch, once seat says whether it is on.
// The items are read again after its box is ticked, so they come from the store, not from what the bar drew.
function openProfiles(anchor: HTMLElement) {
  if (toggled(anchor)) return;
  openMenu({
    anchor, className: "profiles",
    items: () => {
      const seat = seats.seat;
      if (!seat) return [];
      const items: MenuItem[] = seat.profiles.map((p) => ({
        label: p.name, hint: summary(p), current: p.active, group: 0, heading: "Profile",
        run: () => p.active || seats.use(p.name),
      }));
      const auto = seat.auto;
      if (auto !== null) {
        const flip = () => seats.setAuto(!auto);
        items.push({ label: "Auto switch", hint: "seat picks when one is full", group: 1, checked: auto, run: flip, toggle: flip });
      }
      return items;
    },
  });
}
