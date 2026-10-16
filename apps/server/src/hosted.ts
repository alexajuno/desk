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
    req.on("timeout", () => req.destroy(new Error("The session host did not answer")));
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

// Start a host in a systemd scope of its own, so that desk.service's restart leaves it and its sessions running, as
// agents.ownScope does for Claude Code's daemon; its output goes to LOG.
async function launch() {
  mkdirSync(dirname(LOG), { recursive: true });
  const out = openSync(LOG, "a");
  const node = process.execPath;
  const argv = which("systemd-run")
    ? ["systemd-run", "--user", "--scope", "--slice=agents.slice", `--unit=${UNIT}-${Date.now()}`, "--collect", "--quiet", "--", node, HOST, "--socket", SOCKET]
    : [node, HOST, "--socket", SOCKET];
  const { sessionEnv } = await import("./agents.ts");
  spawn(argv[0], argv.slice(1), { cwd: REPO, env: await sessionEnv(), detached: true, stdio: ["ignore", out, out] }).unref();
  for (let i = 0; i < 100; i++) {
    if (await version()) return;
    await sleep(100);
  }
  throw new Error(`The session host did not start; see ${LOG}`);
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

// The sessions the host holds now; none when no host runs (desk starts one only when a session needs it).
export async function sessions(fresh = false): Promise<HostRow[]> {
  if (!fresh && performance.now() - cached[0] < 300) return cached[1];
  let rows: HostRow[] = [];
  try {
    rows = await call<HostRow[]>("GET", "/sessions", undefined, 3000);
  } catch {
    // no host
  }
  cached = [performance.now(), rows];
  return rows;
}

export async function holds(id: string | null | undefined): Promise<HostRow | null> {
  return id ? (await sessions(true)).find((r) => r.id === id) ?? null : null;
}

export async function start(o: StartOptions): Promise<HostRow> {
  await ensure();
  const row = await call<HostRow>("POST", "/sessions", o);
  cached = [0, []];
  return row;
}

export async function send(id: string, content: Content): Promise<HostRow> {
  return call<HostRow>("POST", `/sessions/${id}/send`, { content });
}

export const interrupt = (id: string) => call("POST", `/sessions/${id}/interrupt`, {});
export const answer = (id: string, ask: string, result: Record<string, unknown>) => call("POST", `/sessions/${id}/answer`, { ask, result });
export const close = (id: string) => call("POST", `/sessions/${id}/close`, {});
export const commands = (id: string) => call<{ name: string; description: string; argumentHint?: string }[]>("GET", `/sessions/${id}/commands`);

// The session's event stream from the host (host.ts says what comes over it).
export const events = (id: string) => new WebSocket(`ws+unix://${SOCKET}:/sessions/${id}/events`);

// Wait until the host no longer holds the session: its process has ended.
export async function released(id: string, seconds = 15) {
  const deadline = performance.now() + seconds * 1000;
  while (performance.now() < deadline && (await holds(id))) await sleep(100);
}
