// The tabs each desk session has open in the agents' Chrome, which a chat's Browser shows ("i can view tabs per sessions
// directly on what it's doing", the user, 31 Oct). The session host's browser relay (relay.ts) notes the session that
// opened each, and tells desk over the host's socket (turns.ts), which keeps them in the tabs table:
//
//     {"type": "tab", "target": "<Chrome's id>", "session": "<id>", "url": "...", "title": "..."}   opened, or it moved
//     {"type": "tab-closed", "target": "<Chrome's id>"}
//
// The relay lives as long as its host, and a new host's knows none of the tabs. So its hello says what it noted, and desk
// answers with the rest it keeps, {"type": "owners", "tabs": [{target, session}, ...]}: the relay takes back each one
// still open, and says the others closed. A host with no relay leaves no tab known, and the table empties.
import type { Transaction } from "@electric-sql/pglite";
import type { WebSocket } from "ws";
import * as db from "./db.ts";
import type { Tab } from "./relay.ts";

const keep = (tx: Transaction, t: Tab) =>
  tx.query(`insert into tabs (target, session, url, title, opened) values ($1, $2, $3, $4, $5)
    on conflict (target) do update set url = excluded.url, title = excluded.title`, [t.target, t.session, t.url ?? "", t.title ?? "", new Date().toISOString()]);

export const opened = (t: Tab) => db.write((tx) => keep(tx, t));

export const closed = (target: string) => db.write((tx) => tx.query("delete from tabs where target = $1", [target]));

// The host's hello: relay, whether its relay runs, and tabs, the ones it noted.
export async function hello(ws: WebSocket, relay: boolean | undefined, tabs: Tab[]) {
  const rest = await db.write(async (tx) => {
    if (!relay) return void (await tx.query("delete from tabs"));
    for (const t of tabs) await keep(tx, t);
    return (await tx.query<{ target: string; session: string }>("select target, session from tabs where not (target = any($1))",
      [tabs.map((t) => t.target)])).rows;
  });
  if (rest?.length) ws.send(JSON.stringify({ type: "owners", tabs: rest }));
}
