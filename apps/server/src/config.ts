// Where desk keeps things. The data lives outside the code repo (DESK_DATA, default ~/.local/share/desk), so working on
// desk's code in a worktree, or merging it, never touches the issues.
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const expand = (path: string) => (path.startsWith("~") ? join(homedir(), path.slice(1)) : path);

export const HOME = homedir();
export const DATA_DIR = resolve(expand(process.env.DESK_DATA ?? "~/.local/share/desk"));
export const ISSUES_DIR = join(DATA_DIR, "issues");
export const TRASH_DIR = join(DATA_DIR, "trash");
export const TEAMS_DIR = join(DATA_DIR, "teams");
export const PROJECTS_DIR = join(DATA_DIR, "projects"); // Linear's projects, which finish (projects.ts), since 20 Oct
export const AUTOMATIONS_DIR = join(DATA_DIR, "automations");
export const CHATS_DIR = join(DATA_DIR, "chats");
// The database, beside the data it holds, in DATA_DIR/.db, which git leaves alone (db.ts writes its .gitignore).
export const DB_DIR = resolve(expand(process.env.DESK_DB ?? join(DATA_DIR, ".db", "pg")));
// The code repo: apps/server/src is three levels under it.
export const REPO = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
export const PORT = Number(process.env.PORT ?? 8790);
