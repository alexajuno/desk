// desk's server, started by main.ts once the packages match the commit checked out. PORT picks the port (default 8790),
// DESK_DATA the data folder (default ~/.local/share/desk), and DESK_CLOCK=0 leaves the line's clock and the reaper off,
// as a second desk for testing should.
import { create } from "./app.ts";
import { PORT } from "./config.ts";
import * as db from "./db.ts";
import * as store from "./issues.ts";
import * as land from "./land.ts";
import * as projects from "./projects.ts";
import * as reaper from "./reaper.ts";
import * as sessions from "./sessions.ts";
import * as sync from "./sync.ts";
import * as web from "./web.ts";

await db.open();
// The folders are the record: whatever changed there while desk was down is read in first.
await store.reconcile();
await projects.reconcile();
await web.build();
const app = await create();
await sync.start();
if (process.env.DESK_CLOCK !== "0") {
  land.startClock(); // the line for desk's own checkout moves on its own
  reaper.startClock(); // sessions nobody needs any more are stopped on their own
}

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  // Event streams and sockets stay open as long as a tab does: end them, and the pages reconnect to the desk that comes
  // next.
  sessions.endStreams();
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
