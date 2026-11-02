// seat, the router between the user's Claude profiles (~/projects/seat): personal and work, two plans, and api, the
// $100 of API credits. desk reads its numbers for the status bar and asks it to switch (the user, 1 Nov: "seat, is a
// separate module from desk. which handles auto routing between profiles ... and we'll write a seat connection in desk.
// which will display seat's related numbers"). `seat ls --json` is the contract: desk never reads seat's files.
import { TEST } from "./config.ts";
import { run } from "./proc.ts";
import { HttpError } from "./httperror.ts";

export interface Window {
  percent: number;
  resets: string | null; // ISO 8601; null once the window reset, until seat reads it again
}

export interface Credits {
  budget: number; // dollars
  spent: number; // dollars, at list price, as seat counts them from the transcripts
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
  auto: boolean | null; // null from a seat before its api profile, whose JSON did not say
  profiles: Profile[];
}

// What `seat ls --json` prints: each account with its meters, as seat's daemon last read them, every 5 minutes. A seat
// from before its api profile printed the accounts alone.
interface Meter {
  percent: number;
  resets_at: string | null;
}
interface Account {
  name: string;
  kind?: "plan" | "api";
  active: boolean;
  five_hour: Meter | null;
  week: Meter | null;
  credits?: Credits | null;
}

const FRESH = 30_000; // ms a reading serves, so that every open page asking each minute runs seat about once
let last: { seat: Seat | null; at: number } = { seat: null, at: 0 };
let reading: Promise<Seat | null> | null = null;

// A window whose reset passed since seat read it is unused.
function windowOf(m: Meter | null): Window | null {
  if (!m) return null;
  return m.resets_at && Date.parse(m.resets_at) > Date.now() ? { percent: Math.round(m.percent), resets: m.resets_at } : { percent: 0, resets: null };
}

function parse(stdout: string): Seat {
  const out = JSON.parse(stdout) as Account[] | { auto: boolean; accounts: Account[] };
  const [auto, accounts] = Array.isArray(out) ? [null, out] : [out.auto, out.accounts];
  return {
    auto,
    profiles: accounts.map((a) => ({
      name: a.name, kind: a.kind ?? "plan", active: a.active, five_hour: windowOf(a.five_hour), week: windowOf(a.week), credits: a.credits ?? null,
    })),
  };
}

// seat's profiles now, or null when seat is missing or failed, which the bar shows as no numbers.
async function read(): Promise<Seat | null> {
  reading ??= run(["seat", "ls", "--json"], { timeout: 10 })
    .then((r) => {
      if (r.code !== 0) throw new Error(r.stderr.trim() || `seat ls exited ${r.code}`);
      return parse(r.stdout);
    })
    .catch((error) => (console.error("desk: reading seat", (error as Error).message), null))
    .then((seat) => ((last = { seat, at: Date.now() }), seat))
    .finally(() => (reading = null));
  return reading;
}

// seat's profiles, read again when the last reading is older than half a minute.
export async function profiles(): Promise<Seat | null> {
  return Date.now() - last.at < FRESH ? last.seat : read();
}

// The last reading at once, for what cannot wait, such as a chat's panel; read again in the background when old.
export function now(): Seat | null {
  if (Date.now() - last.at >= FRESH) void read();
  return last.seat;
}

// Makes one of seat's profiles the live one, as `seat switch` does, and gives the profiles as they are then.
export async function use(name: string): Promise<Seat | null> {
  const seat = await profiles();
  if (!seat?.profiles.some((p) => p.name === name)) throw new HttpError(404, `seat has no profile named ${name}.`);
  await ask(["switch", name]);
  return fresh();
}

// Turns seat's own switching on or off, as `seat auto on|off` does.
export async function auto(on: boolean): Promise<Seat | null> {
  await ask(["auto", on ? "on" : "off"]);
  return fresh();
}

// The profiles read after a change, past a reading begun before it, which would give them as they were.
async function fresh(): Promise<Seat | null> {
  await reading;
  return read();
}

async function ask(args: string[]) {
  // Switch and Auto switch change the profile every running session uses, the user's included.
  if (TEST) throw new HttpError(403, "seat is read-only on a test desk.");
  const r = await run(["seat", ...args], { timeout: 30 }).catch((error: Error) => {
    throw new HttpError(502, `seat did not run: ${error.message}`);
  });
  if (r.code !== 0) throw new HttpError(502, `seat ${args.join(" ")}: ${(r.stderr || r.stdout).trim() || `exited ${r.code}`}`);
}
