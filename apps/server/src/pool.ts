// The pool of test desks: each slot runs a session's branch on a port of its own, from 8791, on a fresh copy of the
// user's data, so that 8790 runs main only (2 Nov: "desk is an important part of the workflow on the machine, we can't
// allow it to be interrupted while i'm working, with experiments on certain things").
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { DATA_DIR, HOME } from "./config.ts";
import * as db from "./db.ts";

// Where a slot's copy lives, in the cache, out of the data repo and out of the user's way.
export const dataOf = (port: number) => join(HOME, ".cache", "desk", `test-${port}`);
// The dump of 8790's database the slot's desk loads on its first start (db.ts, DESK_DB_FROM).
export const dumpOf = (port: number) => join(dataOf(port), ".db", "pg.tar");

// What the copy leaves out: the database, which comes as a dump, the data repo's history, and the browser's leftovers.
const LEFT = new Set([".db", ".git", ".playwright-mcp"]);

// A fresh copy of the user's data for the slot on this port: the files as they are now, and a dump of the database,
// which the slot's desk loads into a new folder of its own, whose birth makes its chats' forks new (transcript.ts,
// forkOf). Whatever an earlier slot on the port left goes first.
export async function copy(port: number): Promise<string> {
  const dir = dataOf(port);
  await drop(port);
  await cp(DATA_DIR, dir, { recursive: true, filter: (src) => !LEFT.has(relative(DATA_DIR, src)) });
  const dump = await db.sql().dumpDataDir("none");
  await mkdir(join(dir, ".db"), { recursive: true });
  await writeFile(dumpOf(port), Buffer.from(await dump.arrayBuffer()));
  return dir;
}

// The slot's copy goes once its session gives the slot back.
export async function drop(port: number) {
  if (!Number.isInteger(port) || port <= 8790) throw new Error(`no test slot on port ${port}`);
  await rm(dataOf(port), { recursive: true, force: true });
}
