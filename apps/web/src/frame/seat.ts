// seat, the router between the user's Claude profiles, personal and work, two plans, and api, the $100 of API credits,
// as desk's server reads it (seat.ts there): each profile's numbers, the live one, and whether seat switches on its own.
// The window's bar shows the live one, and its name opens the profiles, to switch one or Auto switch ("A", the user, 2
// Nov; StatusBar.tsx).
import { action, makeObservable, observableRef } from "mobx";
import { postJson, reason } from "../api/http";
import type { Window } from "../sessions/models";
import { toast } from "../ui/toast";

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

  // Makes a profile the live one, as `seat switch` does; the bar then shows what seat says.
  use = (name: string) => this.ask("switch", { name });

  // Turns seat's own switching on or off, as `seat auto on|off` does.
  setAuto = (on: boolean) => this.ask("auto", { on });

  private async ask(what: "switch" | "auto", body: object) {
    const res = await postJson(`/api/seat/${what}`, body).catch(() => null);
    if (!res?.ok) return void toast(res ? await reason(res) : "desk did not answer");
    this.set((await res.json()) as Seat | null);
  }
}

export const seats = new Seats();

// Dollars, whole ones above ten and cents under: "$64", "$4.20".
export const dollars = (n: number) => `$${n >= 10 ? Math.round(n) : Math.max(n, 0).toFixed(2)}`;

// How much of api's credits is spent, in percent, as a ring shows a plan's window used.
export const spent = (c: Credits) => (c.out ? 100 : Math.min(100, Math.round((c.spent / c.budget) * 100)));
