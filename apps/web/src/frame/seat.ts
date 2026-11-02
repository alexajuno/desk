// seat, the router between the user's Claude profiles, personal and work, two plans, and api, the $100 of API credits,
// as desk's server reads it (seat.ts there): each profile's numbers, the live one, and whether seat switches on its own.
// The window's bar shows the live one (StatusBar.tsx; "A", the user, 2 Nov).
import type { Window } from "../sessions/models";

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

// seat's profiles as the server last read them, at most half a minute ago; null when seat is missing or failed.
export async function loadSeat(): Promise<Seat | null> {
  const res = await fetch("/api/seat");
  return res.ok ? ((await res.json()) as Seat | null) : null;
}

// Dollars, whole ones above ten and cents under: "$64", "$4.20".
export const dollars = (n: number) => `$${n >= 10 ? Math.round(n) : Math.max(n, 0).toFixed(2)}`;

// How much of api's credits is spent, in percent, as a ring shows a plan's window used.
export const spent = (c: Credits) => (c.out ? 100 : Math.min(100, Math.round((c.spent / c.budget) * 100)));
