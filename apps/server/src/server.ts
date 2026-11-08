// desk's server, started by main.ts once the packages match the commit checked out. PORT picks the port (default 8790),
// DESK_DATA the data folder (default ~/.local/share/desk), and DESK_ENV=test leaves the test desks' line and the automations'
// clock off, as a slot's desk should (config.ts, ENV).
import { create } from "./app.ts";
import * as auto from "./auto.ts";
import * as automations from "./automations.ts";
import * as chats from "./chats.ts";
import { CONNECT, PORT, TEST } from "./config.ts";
import * as db from "./db.ts";
import * as hosted from "./hosted.ts";
import * as inbox from "./inbox.ts";
import * as logins from "./logins.ts";
import * as firewall from "./firewall.ts";
import * as mail from "./mail.ts";
import * as store from "./issues.ts";
import * as models from "./models.ts";
import * as notices from "./notices.ts";
import * as replies from "./replies.ts";
import * as pins from "./pins.ts";
import * as pool from "./pool.ts";
import * as projects from "./projects.ts";
import * as sessions from "./sessions.ts";
import * as settings from "./settings.ts";
import * as slack from "./slack.ts";
import * as sync from "./sync.ts";
import * as teams from "./teams.ts";
import * as threads from "./threads.ts";
import * as turns from "./turns.ts";
import * as wakes from "./wakes.ts";
import * as web from "./web.ts";

await db.open();
// Postgres is the record, with no file written out beside it: once, the old issue.md, team.md, project.md, plan.md and result.md go.
const gone = await store.leaveFiles();
if (gone) console.log(`desk removed ${gone} files its database now holds`);
await chats.readIn();
await chats.unsubscribeClosed(); // once: the threads of the issues already closed stop waking their chats
const renamed = await store.renameAll(); // once: after the chats, which follow their issues
if (renamed) console.log(`desk gave ${renamed} issues the slug their title makes now`);
await settings.open();
await pins.open();
await models.open();
await turns.load(); // what each session does, as the session host last told desk
await inbox.load();
await web.build();
const app = await create();
await sync.start();
auto.start(); // Auto says next for the user as a turn ends
await wakes.start(); // a followed thread's new messages wake its chat, each minute, on a test desk's made-up ones too
// Once a host's code lands, a host of it starts beside the older one, at once, so that no new chat waits for its start
// (1 Nov: "i start a new chat from ctrl shift o and there was a few seconds delay"); the older one quits once it holds
// no session (hosted.ts).
const keepCurrent = () => void hosted.keepCurrent().catch(() => {});
keepCurrent();
setInterval(keepCurrent, 10_000);
notices.onJudged(sync.frameChanged); // a notice let through makes or moves its thread's Inbox row (pages.ts)
inbox.onRead(threads.seen); // what you read in desk is read in Slack
await replies.recover(); // a reply a stop caught on its way says so on its card
await logins.load(); // a Slack or Gmail login that ended keeps its one row (pages.ts, loginRow)
logins.onChange(sync.frameChanged);
setInterval(() => void notices.prune().catch((error) => console.error("pruning the notices", error)), 3600_000);
if (!TEST) {
  automations.startClock(); // each automation whose time came fires
  pool.start(); // the test desks' line moves on its own
}
if (CONNECT) {
  slack.start(); // Slack's messages come in as notices (notices.ts)
  mail.start(); // and Gmail's mail, read each minute
  firewall.start(); // and Claude judges what no rule settled, each minute
}

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  // Sockets stay open as long as a tab does: close them, and the pages reconnect to the desk that comes next.
  sync.closeAll();
  turns.stop();
  slack.stop();
  mail.stop();
  firewall.stop();
  wakes.stop();
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
