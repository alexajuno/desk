// Where desk keeps things. The data lives outside the code repo (DESK_DATA, default ~/.local/share/desk), so working on
// desk's code in a worktree, or merging it, never touches the issues.
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const expand = (path: string) => (path.startsWith("~") ? join(homedir(), path.slice(1)) : path);

export const HOME = homedir();
export const DATA_DIR = resolve(expand(process.env.DESK_DATA ?? "~/.local/share/desk"));
export const ISSUES_DIR = join(DATA_DIR, "issues");
export const TRASH_DIR = join(DATA_DIR, "trash");
export const TEAMS_DIR = join(DATA_DIR, "teams");
export const PROJECTS_DIR = join(DATA_DIR, "projects"); // Linear's projects, which finish (projects.ts), since 20 Oct
export const AUTOMATIONS_DIR = join(DATA_DIR, "automations");
export const UPLOADS_DIR = join(DATA_DIR, "uploads"); // the files attached in a composer, by session (uploads.ts)
// The database, beside the data it holds, in DATA_DIR/.db, which git leaves alone (db.ts writes its .gitignore).
export const DB_DIR = resolve(expand(process.env.DESK_DB ?? join(DATA_DIR, ".db", "pg")));
// The code repo: apps/server/src is three levels under it.
export const REPO = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
export const PORT = Number(process.env.PORT ?? 8790);
// Which desk this is: main, the one the user works in, or test, a slot's desk (pool.ts) that runs a branch on a copy of
// the data and leaves the user's things alone: its line, automations and browser relay stay off, Approve runs no
// landing step, a copied chat's session runs as a fork (transcript.ts, forkOf), seat is read-only and its terminals are
// its own (2 Nov: "usually people name it app environment = prod, local ... here probably we have main and test").
export const ENV = process.env.DESK_ENV === "test" ? "test" : "main";
export const TEST = ENV === "test";
// Whether desk connects to Slack and Gmail and listens (slack.ts): the user's desk does, and a test desk only when told
// with DESK_CONNECT=1, so that two desks never pop the same message up twice. DESK_CONNECT=0 keeps any desk off them.
export const CONNECT = process.env.DESK_CONNECT ? process.env.DESK_CONNECT === "1" : !TEST;
// The session host's browser relay (relay.ts), which a desk moves with DESK_RELAY_PORT, or turns off with 0, as a test
// desk does unless told. 9335 and 9336 are the phone's mobile-mcp.
export const RELAY_PORT = Number(process.env.DESK_RELAY_PORT ?? (TEST ? 0 : 9340));
