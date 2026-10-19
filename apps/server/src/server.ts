// desk's server, started by main.ts once the packages match the commit checked out. PORT picks the port (default 8790),
// DESK_DATA the data folder (default ~/.local/share/desk), and DESK_CLOCK=0 leaves the line's clock, the automations'
// clock and the Slack connection off, as a second desk for testing should.
import { create } from "./app.ts";
import * as automations from "./automations.ts";
import { PORT } from "./config.ts";
import * as db from "./db.ts";
import * as hosted from "./hosted.ts";
import * as store from "./issues.ts";
import * as land from "./land.ts";
import * as projects from "./projects.ts";
import * as slack from "./slack.ts";
import * as sync from "./sync.ts";
import * as web from "./web.ts";

await db.open();
// The folders are the record: whatever changed there while desk was down is read in first.
await store.reconcile();
await projects.reconcile();
await web.build();
const app = await create();
await sync.start();
// A session host left from older code gives way to one of this code once none of its sessions works.
setInterval(() => void hosted.keepCurrent().catch(() => {}), 60_000);
if (process.env.DESK_CLOCK !== "0") {
  land.startClock(); // the line for desk's own checkout moves on its own
  slack.connect(); // Slack pushes each 🐧 the user adds, and its message comes into Triage
  automations.startClock(); // each automation whose time came fires
}

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  // Sockets stay open as long as a tab does: close them, and the pages reconnect to the desk that comes next.
  sync.closeAll();
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
