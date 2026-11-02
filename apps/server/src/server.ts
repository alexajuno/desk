// desk's server, started by main.ts once the packages match the commit checked out. PORT picks the port (default 8790),
// DESK_DATA the data folder (default ~/.local/share/desk), and DESK_ENV=test leaves the line and the automations' clock
// off, as a slot's desk should (config.ts, ENV).
import { create } from "./app.ts";
import * as auto from "./auto.ts";
import * as automations from "./automations.ts";
import * as chats from "./chats.ts";
import { PORT, TEST } from "./config.ts";
import * as db from "./db.ts";
import * as hosted from "./hosted.ts";
import * as inbox from "./inbox.ts";
import * as store from "./issues.ts";
import * as land from "./land.ts";
import * as models from "./models.ts";
import * as pins from "./pins.ts";
import * as pool from "./pool.ts";
import * as projects from "./projects.ts";
import * as sessions from "./sessions.ts";
import * as settings from "./settings.ts";
import * as sync from "./sync.ts";
import * as teams from "./teams.ts";
import * as turns from "./turns.ts";
import * as web from "./web.ts";

await db.open();
// Postgres is the record. A new database, or one lost, starts from the issue.md, team.md and project.md desk wrote out.
await teams.moveFolders(); // before projects.importAll, which reads projects/, where the teams' folders were
const issues = await store.importAll(), teamCount = await teams.importAll(), projectCount = await projects.importAll();
if (issues || teamCount || projectCount)
  console.log(`desk read ${issues} issue.md, ${teamCount} team.md and ${projectCount} project.md into a new database`);
const rewritten = await store.rewrite();
if (rewritten) console.log(`desk wrote ${rewritten} issue.md out again, as their rows now hold them`);
await store.readLanded();
await chats.readIn();
const adopted = await chats.adoptSessions(); // once: the sessions no chat held become chats on their issues
if (adopted) console.log(`desk made ${adopted} sessions with no chat into chats on their issues`);
const left = await chats.adoptLeft(); // once: an open issue whose chat went on to another gets a chat of its own
if (left) console.log(`desk gave ${left} open issues whose chat had moved on a chat of their own`);
const renamed = await store.renameAll(); // once: after the chats, which follow their issues
if (renamed) console.log(`desk gave ${renamed} issues the slug their title makes now`);
// What a desk of an older branch changed in the files desk kept its state in before Postgres, while it ran (copies.ts).
await settings.open();
await pins.open();
await models.open();
await turns.load(); // what each session does, as the session host last told desk
await inbox.load();
await web.build();
const app = await create();
await sync.start();
auto.start(); // Auto says next for the user as a turn ends
// A session host left from older code gives way to one of this code once none of its sessions works: at once, and
// soon after it goes quiet, so that the swap's few seconds fall on no new chat, whose start would wait for it (1 Nov:
// "i start a new chat from ctrl shift o and there was a few seconds delay").
const keepCurrent = () => void hosted.keepCurrent().catch(() => {});
keepCurrent();
setInterval(keepCurrent, 10_000);
setInterval(() => void db.prune().catch((error) => console.error("pruning the log", error)), 3600_000);
if (!TEST) {
  land.start(); // the line for desk's own checkout moves on its own
  automations.startClock(); // each automation whose time came fires
  pool.start(); // the test desks' line moves on its own
}

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  // Sockets stay open as long as a tab does: close them, and the pages reconnect to the desk that comes next.
  sync.closeAll();
  turns.stop();
  const late = setTimeout(() => process.exit(0), 5000);
  try {
    await app.close();
    await db.close();
  } finally {
    clearTimeout(late);
    process.exit(0);
  }
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);

await app.listen({ port: PORT, host: process.env.HOST ?? "127.0.0.1" });
console.log(`desk on http://127.0.0.1:${PORT}`);
// The Sessions menu's search reads the prompts written while desk was down, or all of them into a new database.
void sessions.index();
