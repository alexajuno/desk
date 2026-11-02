// The sessions the user pinned to the sidebar's Pinned, in the order they were pinned: "i have a long running chat,
// and i wanna resume it obviously" (the user, 19 Oct). The pins table holds them, by session, since an issue's session
// desk started in the background has no chat to keep it in.
import * as db from "./db.ts";
import { sql } from "./db.ts";

// What the table holds, kept here as well for the frame, which every write rebuilds.
let kept: string[] = [];

// Read the pins, once, as desk starts.
export async function open() {
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
}
