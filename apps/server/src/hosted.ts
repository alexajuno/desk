// desk's side of the session hosts (host.ts): starting one of the code checked out now when a session needs it, and at
// once beside one of older code, which drains; and asking each its things over its unix socket. Each desk port keeps
// its own, so a test desk's never meet the user's.
//
// Each host listens on a socket named by its version, desk-host-<port>-<version>.sock, so that one of new code starts
// beside one still running a turn. A new session starts on the host of the code checked out now; anything for a session
// goes to the host that holds it, and one idle on a host of older code moves to the newest on its next message (send).
// A host of older code takes no new session, closes each of its own once idle for 5 minutes (host.ts), and desk asks it
// to quit once it lists none (keepCurrent). Until 2 Nov one host ran on
// desk-host-<port>.sock, swapped only once every session had been quiet for 10 minutes, and on 2 Nov that took 46 ("i
// can't create new session for 10min. which is kinda suck", the user).
import { createHash } from "node:crypto";
import { mkdirSync, openSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { basename, dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { WebSocket } from "ws";
import { HOME, PORT, RELAY_PORT, REPO, TEST } from "./config.ts";
import { sleep, which } from "./proc.ts";
import { find, forkOf, pathOf } from "./transcript.ts";

const RUN = process.env.XDG_RUNTIME_DIR || "/tmp";
const NAMED = new RegExp(`^desk-host-${PORT}-([0-9a-f]{12})\\.sock$`);
const OLD = `desk-host-${PORT}.sock`; // the one socket of a host from before 2 Nov
const socketOf = (version: string) => join(RUN, `desk-host-${PORT}-${version}.sock`);
const HOST = join(REPO, "apps", "server", "src", "host.ts");
// The files a host runs, whose content is its version: the same list as host.ts's VERSION, or desk takes every host for
// an older one and starts another beside it, on the same socket, each time one says hello.
const CODE = ["host.ts", "relay.ts", "chrome.ts"].map((f) => join(dirname(HOST), f));
const LOG = join(HOME, ".cache", "desk", `host-${PORT}.log`);
const UNIT = `desk-host-${PORT}`;

export interface HostRow {
  id: string;
  cwd: string;
  title: string;
  working: boolean;
  since: number;
  asks: number;
  tasks?: number; // running in the background; a host from before 2 Nov does not say
  watchers: number;
}

// A host that answers: its socket, and the version of the code it runs.
interface Host {
  socket: string;
  version: string;
}

export type Content = string | Record<string, unknown>[];

export interface StartOptions {
  id?: string;
  resume?: boolean;
  cwd: string;
  title?: string;
  append?: string;
  model?: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  permissionMode?: "default" | "acceptEdits" | "bypassPermissions" | "plan" | "auto" | "dontAsk";
  disallowedTools?: string[];
  additionalDirectories?: string[];
  agent?: string;
  settings?: Record<string, unknown>;
  message?: Content;
  // On a test desk, the id the session runs as in Claude Code (transcript.ts, forkOf), resumed, or with fork, forked
  // from the session's own transcript, which stays as it was.
  as?: string;
  fork?: boolean;
}

// The version a host of the code checked out now would report (host.ts computes it the same way).
const current = () => CODE.reduce((h, f) => h.update(readFileSync(f)), createHash("sha1")).digest("hex").slice(0, 12);
export const version = current;

export class HostError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

function call<T>(socket: string, method: string, path: string, body?: unknown, timeout = 30_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = httpRequest({ socketPath: socket, path, method, timeout, headers: data ? { "content-type": "application/json" } : {} }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (text += c));
      res.on("end", () => {
        let json: unknown = null;
        try {
          json = text ? JSON.parse(text) : null;
        } catch {
          json = { message: text };
        }
        if ((res.statusCode ?? 500) >= 400) {
          const j = json as { detail?: string; message?: string } | null;
          reject(new HostError(j?.detail ?? j?.message ?? `The session host answered ${res.statusCode}`, res.statusCode ?? 500));
        } else resolve(json as T);
      });
    });
    req.on("timeout", () => req.destroy(new HostError("The session host did not answer", 504)));
    req.on("error", reject);
    req.end(data);
  });
}

const versionAt = async (socket: string) => (await call<{ version: string }>(socket, "GET", "/version", undefined, 2000)).version;

// The sockets a host of this desk may listen on: one per version that ran, and the one from before 2 Nov.
function sockets(): string[] {
  let names: string[] = [];
  try {
    names = readdirSync(RUN);
  } catch {
    // no runtime folder, so no host
  }
  return names.filter((n) => n === OLD || NAMED.test(n)).map((n) => join(RUN, n));
}

let known: Host[] = []; // the hosts at the last look

// The hosts that answer now.
async function look(): Promise<Host[]> {
  const found = await Promise.all(sockets().map(async (socket): Promise<Host | null> => {
    try {
      return { socket, version: await versionAt(socket) };
    } catch (e) {
      // One too busy to answer still runs, of the version it said before, or its socket's name says.
      if (e instanceof HostError && e.status === 504)
        return { socket, version: known.find((h) => h.socket === socket)?.version ?? NAMED.exec(basename(socket))?.[1] ?? "" };
      // Nothing listens there: a host that ended left it, unless one is starting, which may be about to listen on it.
      if ((e as NodeJS.ErrnoException).code === "ECONNREFUSED" && !launching) rmSync(socket, { force: true });
      return null;
    }
  }));
  return (known = found.filter((h): h is Host => h !== null));
}

// Start a host of the code checked out now, on the socket of its version, in a systemd scope of its own, so that
// desk.service's restart, which stops everything in its cgroup, leaves it and its sessions running (on 15 Oct one
// restart of desk killed every session it had started); its output goes to LOG.
async function launch(version: string): Promise<Host> {
  const socket = socketOf(version);
  mkdirSync(dirname(LOG), { recursive: true });
  const out = openSync(LOG, "a");
  const node = process.execPath;
  const args = ["--socket", socket, "--desk", `http://127.0.0.1:${PORT}`, // the host tells desk what each session does (turns.ts)
    "--relay", String(RELAY_PORT)];
  const argv = which("systemd-run")
    ? ["systemd-run", "--user", "--scope", "--slice=agents.slice", `--unit=${UNIT}-${Date.now()}`, "--collect", "--quiet", "--", node, HOST, ...args]
    : [node, HOST, ...args];
  const { sessionEnv } = await import("./agents.ts");
  spawn(argv[0], argv.slice(1), { cwd: REPO, env: await sessionEnv(), detached: true, stdio: ["ignore", out, out] }).unref();
  for (let i = 0; i < 100; i++) {
    try {
      return { socket, version: await versionAt(socket) };
    } catch {
      await sleep(100);
    }
  }
  throw new Error(`The session host did not start; see ${LOG}`);
}

// A start under way, one at a time: a session's and desk's tick could otherwise start two hosts on the same socket, and
// the second would leave the first running with no way in.
let launching: Promise<Host> | null = null;

// The host of the code checked out now, started if none answers.
function newest(): Promise<Host> {
  return (launching ??= (async () => {
    try {
      const version = current();
      return (await look()).find((h) => h.version === version) ?? (await launch(version));
    } finally {
      launching = null;
    }
  })());
}

// Which hosts answer now: none, or one of the code checked out now among them, or only older ones; and which holds
// each session (sessions).
export async function standing(): Promise<"none" | "current" | "older"> {
  const hosts = await look(), version = current();
  await sessions(true);
  return !hosts.length ? "none" : hosts.some((h) => h.version === version) ? "current" : "older";
}

// desk's tick: each host of older code is asked to quit once it lists no session, and refuses while one works, so a
// later tick asks again. Once code lands, a host of it starts at once, beside the older ones, which take no new session.
export async function keepCurrent(): Promise<void> {
  const version = current();
  const older = (await look()).filter((h) => h.version !== version);
  if (!older.length) return;
  for (const h of older) {
    try {
      if (!(await call<HostRow[]>(h.socket, "GET", "/sessions", undefined, 3000)).length) await call(h.socket, "POST", "/quit", {}, 5000);
    } catch {
      // busy, or gone already
    }
  }
  await newest();
}

const listed = new Map<string, HostRow[]>(); // what each host last listed, by its socket
const where = new Map<string, string>(); // each session, by the socket of the host that holds it
let cached: [number, HostRow[]] = [0, []];

// The sessions every host holds now; none when no host runs (desk starts one only when a session needs it). A host too
// busy to answer in time still holds what it last listed: read as none, every working session would be your turn.
export async function sessions(fresh = false): Promise<HostRow[]> {
  if (!fresh && performance.now() - cached[0] < 300) return cached[1];
  const all = sockets();
  await Promise.all(all.map(async (socket) => {
    try {
      listed.set(socket, await call<HostRow[]>(socket, "GET", "/sessions", undefined, 3000));
    } catch (e) {
      if (!(e instanceof HostError && e.status === 504)) listed.delete(socket); // otherwise no host there
    }
  }));
  where.clear();
  for (const [socket, rows] of listed) {
    if (!all.includes(socket)) listed.delete(socket);
    else for (const r of rows) where.set(r.id, socket);
  }
  cached = [performance.now(), [...listed.values()].flat()];
  return cached[1];
}

export async function holds(id: string | null | undefined): Promise<HostRow | null> {
  return id ? (await sessions(true)).find((r) => r.id === id) ?? null : null;
}

// The socket of the host holding the session, as last listed; with none, the newest's, where each session starts.
const at = (id: string) => where.get(id) ?? socketOf(current());

// Each session starts on the host of the code checked out now. One an older host still holds stays there, as one host
// would refuse a second process of a session it holds.
export async function start(o: StartOptions): Promise<HostRow> {
  if (TEST && o.id) {
    // On a test desk a session runs as its fork: resumed once the fork has run, forked from the session's transcript
    // before that, or started under the fork's id when the session never got a message.
    const as = forkOf(o.id), ran = Boolean(find(as));
    o = { ...o, as, resume: ran, fork: !ran && Boolean(find(o.id)) };
  } else if (o.resume && o.id && !pathOf(o.id)) o = { ...o, resume: false }; // never got a message: starts afresh, under the same id
  const host = await newest();
  if (o.id && (await holds(o.id)) && where.get(o.id) !== host.socket) throw new HostError("An older session host still holds this session", 409);
  const row = await call<HostRow>(host.socket, "POST", "/sessions", o);
  where.set(row.id, host.socket);
  cached = [0, []];
  return row;
}

// Now: Claude reads it at once, as Claude Code's send now (host.ts, /send). A session idle on a host of older code, not
// working, asking or running a task, moves to the newest instead: closed there, and the 404 tells the caller to start
// it again with the message (agents.ts, tell), as one the host closed. One a host from before 2 Nov holds stays: its
// list says no tasks, so it might be running one.
export async function send(id: string, content: Content, uuid?: string, now = false): Promise<HostRow> {
  const socket = at(id), row = listed.get(socket)?.find((r) => r.id === id);
  if (socket !== socketOf(current()) && row && !row.working && !row.asks && row.tasks === 0) {
    await close(id);
    throw new HostError("It moves to the newest session host", 404);
  }
  return call<HostRow>(socket, "POST", `/sessions/${id}/send`, { content, ...(uuid ? { uuid } : {}), ...(now ? { priority: "now" } : {}) });
}

export const withdraw = async (id: string, uuid: string) => (await call<{ withdrawn: boolean }>(at(id), "POST", `/sessions/${id}/withdraw`, { uuid })).withdrawn;

export const interrupt = (id: string) => call(at(id), "POST", `/sessions/${id}/interrupt`, {});
export const answer = (id: string, ask: string, result: Record<string, unknown>) => call(at(id), "POST", `/sessions/${id}/answer`, { ask, result });
export const commands = (id: string) => call<{ name: string; description: string; argumentHint?: string }[]>(at(id), "GET", `/sessions/${id}/commands`);
export const settings = (id: string, set: { model?: string; effort?: StartOptions["effort"] }) => call<HostRow>(at(id), "POST", `/sessions/${id}/settings`, set);
export const context = (id: string) => call<{ tokens: number; max: number; percent: number }>(at(id), "GET", `/sessions/${id}/context`);

// The session's event stream from the host holding it (host.ts says what comes over it).
export const events = (id: string) => new WebSocket(`ws+unix://${at(id)}:/sessions/${id}/events`);

// Close the session's process; its transcript stays, and its next message starts it again. The host answers once the
// process has ended (15 s at most), so that it can start again at once on any host. A host from before 2 Nov answers
// at once, and its own wait for the end, in POST /sessions, does not cover a start on another host: desk gives the
// process a second.
export async function close(id: string): Promise<void> {
  const socket = at(id);
  await call(socket, "POST", `/sessions/${id}/close`, {});
  cached = [0, []];
  if (basename(socket) === OLD) await sleep(1000);
}
