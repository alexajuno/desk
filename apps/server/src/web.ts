// desk's app (apps/web: React, MobX, StyleX), the page behind every one of desk's addresses (ported from desk/web.py).
//
// desk.service runs whatever commit Try, back-to-main or a landing checked out, so desk builds the app itself when it
// starts, whenever the app's committed sources differ from the ones its last build came from. With nothing changed
// that costs one `git rev-parse`; a build, pnpm's install check included, took 1.2 s with its store warm (16 Oct).
import { createReadStream, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";
import type { FastifyReply } from "fastify";
import { HOME, REPO } from "./config.ts";
import { HttpError } from "./pages.ts";
import { run } from "./proc.ts";

const DIST = join(REPO, "apps", "web", "dist");
const STAMP = join(DIST, ".source"); // the git tree of apps/web the build in DIST was made from
// pnpm and node come from volta, which desk.service's PATH leaves out
const PATH = `${join(HOME, ".volta", "bin")}:${process.env.PATH ?? ""}`;

// The tree apps/web has in the commit checked out: it changes exactly when the app's code does.
const source = async () => (await run(["git", "rev-parse", "HEAD:apps/web"], { cwd: REPO })).stdout.trim();

// Build the app if its sources changed since the last build. A failed build leaves the last one served, and the log
// says why.
export async function build() {
  const tree = await source();
  if (!tree || (existsSync(STAMP) && readFileSync(STAMP, "utf8") === tree)) return;
  const env = { ...process.env, PATH };
  for (const step of [["pnpm", "install", "--frozen-lockfile", "--prefer-offline"], ["pnpm", "build"]]) {
    const done = await run(step, { cwd: REPO, env, timeout: 300 }).catch((error: Error) => ({ code: 1, stdout: "", stderr: String(error) }));
    if (done.code) {
      console.error(`Building the app failed at \`${step.join(" ")}\`:\n${(done.stdout + done.stderr).slice(-4000)}`);
      return;
    }
  }
  writeFileSync(STAMP, tree);
}

// What Python's mimetypes, which Starlette's FileResponse asks, names each kind of file desk serves.
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json", ".map": "application/json", ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
  ".ico": "image/vnd.microsoft.icon", ".ttf": "font/ttf", ".woff": "font/woff", ".woff2": "font/woff2", ".pdf": "application/pdf",
  ".txt": "text/plain; charset=utf-8", ".csv": "text/csv; charset=utf-8", ".mp4": "video/mp4", ".webm": "video/webm",
  ".xml": "application/xml", ".zip": "application/zip", ".gz": "application/gzip", ".py": "text/x-python; charset=utf-8",
  ".sh": "application/x-sh", ".yaml": "application/yaml", ".yml": "application/yaml", ".wasm": "application/wasm",
};

// A file as it is, with its type, size and time, as Starlette's FileResponse sends one.
export function sendFile(reply: FastifyReply, path: string, cache?: string) {
  const stat = statSync(path);
  reply.header("content-type", TYPES[extname(path).toLowerCase()] ?? "text/plain; charset=utf-8");
  reply.header("content-length", stat.size);
  reply.header("last-modified", stat.mtime.toUTCString());
  reply.header("etag", `"${(stat.mtimeMs / 1000).toString(16)}-${stat.size.toString(16)}"`);
  if (cache) reply.header("cache-control", cache);
  return reply.send(createReadStream(path));
}

// The app's page, for any of desk's own addresses: the app draws whichever page the address names.
export function index(reply: FastifyReply) {
  const page = join(DIST, "index.html");
  if (!existsSync(page)) throw new HttpError(503, "The app is not built: desk builds it when it starts, and the log says why it failed.");
  return sendFile(reply, page, "no-cache");
}

// One of the build's own files, when the path stays inside it.
export function asset(reply: FastifyReply, path: string, cache: string) {
  const dist = resolve(DIST), file = resolve(dist, path);
  if (!file.startsWith(dist + sep) || !existsSync(file) || !statSync(file).isFile()) throw new HttpError(404, "Not Found");
  return sendFile(reply, file, cache);
}
