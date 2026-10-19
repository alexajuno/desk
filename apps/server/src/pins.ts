// The sessions the user pinned to the sidebar's Pinned, in the order they were pinned: "i have a long running chat,
// and i wanna resume it obviously" (the user, 19 Oct). The pins table holds them, by session, since an issue's session
// desk started in the background has no chat to keep it in.
import { join } from "node:path";
import { DATA_DIR } from "./config.ts";
import * as copies from "./copies.ts";
import * as db from "./db.ts";
import { sql } from "./db.ts";

const FILE = join(DATA_DIR, "pins.json"); // where they were until 19 Oct, written out still (copies.ts)

// What the table holds, kept here as well for the frame, which every write rebuilds.
let kept: string[] = [];

// Read the pins, once, as desk starts: those of pins.json first when a desk of an older branch changed it.
export async function open() {
  const text = await copies.changed(FILE);
  if (text !== undefined) {
    let sessions: string[] = [];
    try {
      sessions = text ? (JSON.parse(text) as { sessions: string[] }).sessions : [];
    } catch {
      // a file broken by hand counts as none
    }
    await db.write(async (tx) => {
      await tx.query("delete from pins");
      for (const session of new Set(sessions)) await tx.query("insert into pins (session) values ($1)", [session]);
    });
    await copies.taken(FILE, text);
  }
  kept = (await sql().query<{ session: string }>("select session from pins order by seq")).rows.map((r) => r.session);
}

export const all = (): string[] => kept;

// Pin the session, last in Pinned, or unpin it.
export async function set(session: string, pinned: boolean) {
  await db.write(async (tx) => {
    await tx.query("delete from pins where session = $1", [session]);
    if (pinned) await tx.query("insert into pins (session) values ($1)", [session]);
  });
  kept = [...kept.filter((s) => s !== session), ...(pinned ? [session] : [])];
  await copies.out(FILE, JSON.stringify({ sessions: kept }));
}
