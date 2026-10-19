// desk's side of the session host (host.ts): starting it when none answers, replacing it with a newer one while nothing
// works, and asking it things over its unix socket. One host per desk port, so a second desk for testing keeps its own.
import { createHash } from "node:crypto";
import { mkdirSync, openSync, readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { WebSocket } from "ws";
import { HOME, PORT, REPO } from "./config.ts";
import { sleep, which } from "./proc.ts";
import { pathOf } from "./transcript.ts";

export const SOCKET = join(process.env.XDG_RUNTIME_DIR || "/tmp", `desk-host-${PORT}.sock`);
const HOST = join(REPO, "apps", "server", "src", "host.ts");
const LOG = join(HOME, ".cache", "desk", `host-${PORT}.log`);
const UNIT = `desk-host-${PORT}`;

export interface HostRow {
  id: string;
  cwd: string;
  title: string;
  working: boolean;
  since: number;
  asks: number;
  watchers: number;
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
}

// The version a host of the code checked out now would report (host.ts computes it the same way).
const current = () => createHash("sha1").update(readFileSync(HOST)).digest("hex").slice(0, 12);

export class HostError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

function call<T>(method: string, path: string, body?: unknown, timeout = 30_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = httpRequest({ socketPath: SOCKET, path, method, timeout, headers: data ? { "content-type": "application/json" } : {} }, (res) => {
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

async function version(): Promise<string | null> {
  try {
    return (await call<{ version: string }>("GET", "/version", undefined, 2000)).version;
  } catch {
    return null;
  }
}

// Start a host in a systemd scope of its own, so that desk.service's restart, which stops everything in its cgroup,
// leaves it and its sessions running (on 15 Oct one restart of desk killed every session it had started); its output
// goes to LOG.
async function launch() {
  mkdirSync(dirname(LOG), { recursive: true });
  const out = openSync(LOG, "a");
  const node = process.execPath;
  const args = ["--socket", SOCKET, "--desk", `http://127.0.0.1:${PORT}`]; // the host tells desk what each session does (turns.ts)
  const argv = which("systemd-run")
    ? ["systemd-run", "--user", "--scope", "--slice=agents.slice", `--unit=${UNIT}-${Date.now()}`, "--collect", "--quiet", "--", node, HOST, ...args]
    : [node, HOST, ...args];
  const { sessionEnv } = await import("./agents.ts");
  spawn(argv[0], argv.slice(1), { cwd: REPO, env: await sessionEnv(), detached: true, stdio: ["ignore", out, out] }).unref();
  for (let i = 0; i < 100; i++) {
    if (await version()) return;
    await sleep(100);
  }
  throw new Error(`The session host did not start; see ${LOG}`);
}

// Which host answers now: none, one of the code checked out now, or one of older code.
export async function standing(): Promise<"none" | "current" | "older"> {
  const v = await version();
  return !v ? "none" : v === current() ? "current" : "older";
}

let starting: Promise<void> | null = null;

// A host of the code checked out now, started if none answers.
export function ensure(): Promise<void> {
  starting ??= (async () => {
    try {
      const v = await version();
      if (v && v !== current()) await replace();
      else if (!v) await launch();
    } finally {
      starting = null;
    }
  })();
  return starting;
}

// Swap a host running older code for one of the code checked out now, but only while none of its sessions works or
// waits on the user: their processes end with it, and each resumes on its next message.
async function replace(): Promise<boolean> {
  try {
    await call("POST", "/quit", {}, 5000);
  } catch {
    return false; // busy: the old one serves until it is idle
  }
  for (let i = 0; i < 50 && (await version()); i++) await sleep(100);
  await launch();
  return true;
}

// Called now and then: a host left over from older code is replaced once it is idle.
export async function keepCurrent() {
  const v = await version();
  if (v && v !== current()) await replace();
}

let cached: [number, HostRow[]] = [0, []];

// The sessions the host holds now; none when no host runs (desk starts one only when a session needs it). A host too
// busy to answer in time still holds what it last listed: read as none, every working session would be your turn.
export async function sessions(fresh = false): Promise<HostRow[]> {
  if (!fresh && performance.now() - cached[0] < 300) return cached[1];
  let rows: HostRow[] = [];
  try {
    rows = await call<HostRow[]>("GET", "/sessions", undefined, 3000);
  } catch (e) {
    if (e instanceof HostError && e.status === 504) rows = cached[1]; // otherwise no host
  }
  cached = [performance.now(), rows];
  return rows;
}

export async function holds(id: string | null | undefined): Promise<HostRow | null> {
  return id ? (await sessions(true)).find((r) => r.id === id) ?? null : null;
}

export async function start(o: StartOptions): Promise<HostRow> {
  // A session that never got a message has no transcript to resume: it starts afresh, under the same id.
  if (o.resume && o.id && !pathOf(o.id)) o = { ...o, resume: false };
  await ensure();
  // A host of older code drops what it does not know, and would run an agent's chat as a plain session.
  if (o.agent && (await version()) !== current())
    throw new HostError("desk's session host runs older code, which cannot start an agent yet. It updates itself once no session has worked for 10 minutes; try again then.", 503);
  const row = await call<HostRow>("POST", "/sessions", o);
  cached = [0, []];
  return row;
}

// Now: Claude reads it at once, as Claude Code's send now (host.ts, /send). A host of older code sends it as any other.
export async function send(id: string, content: Content, uuid?: string, now = false): Promise<HostRow> {
  return call<HostRow>("POST", `/sessions/${id}/send`, { content, ...(uuid ? { uuid } : {}), ...(now ? { priority: "now" } : {}) });
}

export const withdraw = async (id: string, uuid: string) => (await call<{ withdrawn: boolean }>("POST", `/sessions/${id}/withdraw`, { uuid })).withdrawn;

export const interrupt = (id: string) => call("POST", `/sessions/${id}/interrupt`, {});
export const answer = (id: string, ask: string, result: Record<string, unknown>) => call("POST", `/sessions/${id}/answer`, { ask, result });
export const close = (id: string) => call("POST", `/sessions/${id}/close`, {});
export const commands = (id: string) => call<{ name: string; description: string; argumentHint?: string }[]>("GET", `/sessions/${id}/commands`);
export const settings = (id: string, set: { model?: string; effort?: StartOptions["effort"] }) => call<HostRow>("POST", `/sessions/${id}/settings`, set);
export const context = (id: string) => call<{ tokens: number; max: number; percent: number }>("GET", `/sessions/${id}/context`);

// The session's event stream from the host (host.ts says what comes over it).
export const events = (id: string) => new WebSocket(`ws+unix://${SOCKET}:/sessions/${id}/events`);

// Wait until the host no longer holds the session: its process has ended.
export async function released(id: string, seconds = 15) {
  const deadline = performance.now() + seconds * 1000;
  while (performance.now() < deadline && (await holds(id))) await sleep(100);
}
