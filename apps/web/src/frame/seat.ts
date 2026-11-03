// seat, the router between the user's Claude profiles, personal and work, two plans, and api, the $100 of API credits,
// as desk's server reads it (seat.ts there): each profile's numbers, the live one, and whether seat switches on its own.
// The model menu shows the live one under its Usage (sessions/models.ts). The bar along the window's bottom that also
// showed it, and switched profiles, left on 3 Nov ("i don't think i need it"); `seat switch` does that now.
import { action, makeObservable, observableRef } from "mobx";

export interface Window {
  percent: number;
  resets: string | null; // null once it reset, until seat hears when it next does
}

export interface Credits {
  budget: number; // dollars
  spent: number;
  out: boolean; // the API said they are gone
}

export interface Profile {
  name: string;
  kind: "plan" | "api";
  active: boolean;
  five_hour: Window | null; // null for api, and for a meter seat could not read
  week: Window | null;
  credits: Credits | null; // api's only
}

export interface Seat {
  auto: boolean | null; // null from a seat that does not say yet
  profiles: Profile[];
}

class Seats {
  seat: Seat | null = null; // as the server last read it, at most half a minute ago; null when seat is missing or failed

  constructor() {
    makeObservable(this, { seat: observableRef, set: action });
  }

  set(seat: Seat | null) {
    this.seat = seat;
  }

  async load() {
    const res = await fetch("/api/seat").catch(() => null);
    if (res) this.set(res.ok ? ((await res.json()) as Seat | null) : null);
  }
}

export const seats = new Seats();

// Dollars, whole ones above ten and cents under: "$64", "$4.20".
export const dollars = (n: number) => `$${n >= 10 ? Math.round(n) : Math.max(n, 0).toFixed(2)}`;

// How much of api's credits is spent, in percent, as a ring shows a plan's window used.
export const spent = (c: Credits) => (c.out ? 100 : Math.min(100, Math.round((c.spent / c.budget) * 100)));

// When a window resets, to the nearest minute (it says 05:59:59.9 for 06:00): the time today, or the day and time when
// it is further off.
export function resets(iso: string): string {
  const at = new Date(Math.round(new Date(iso).getTime() / 60_000) * 60_000), time = at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  return at.getTime() - Date.now() < 20 * 3600_000 ? time : `${at.toLocaleDateString([], { weekday: "short" })} ${time}`;
}

export interface Meter {
  word: string;
  percent: number; // used, for its ring
  text: string; // "96%", "$64 left", or a dash for a meter seat could not read
  about: string; // when it resets, or what is spent
}

// A profile's own numbers: a plan's 5-hour and Week, or api's credits, each after its word. The bar draws them as rings
// and the phone's model menu as lines, so the two always say the same.
export function meters(p: Profile): Meter[] {
  if (p.kind === "api") {
    const c = p.credits;
    if (!c) return [{ word: "Credits", percent: 0, text: "–", about: "seat has not counted them" }];
    return [{ word: "Credits", percent: spent(c), text: c.out ? "out" : `${dollars(c.budget - c.spent)} left`,
      about: c.out ? "the API said they are gone" : `$${c.spent.toFixed(2)} of ${dollars(c.budget)} spent` }];
  }
  const limit = (word: string, w: Window | null): Meter => w
    ? { word, percent: w.percent, text: `${w.percent}%`, about: w.resets ? `resets ${resets(w.resets)}` : "not started" }
    : { word, percent: 0, text: "–", about: "seat has no number for it" };
  return [limit("5-hour", p.five_hour), limit("Week", p.week)];
}
