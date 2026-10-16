// desk: one place to park, plan, run and review issues with Claude. Run: node apps/server/src/main.ts (desk.service
// does). Try, back-to-main and a landing switch the commit under desk.service, which then restarts desk; a commit may
// need packages the last one did not. So before anything else, desk installs them whenever pnpm-lock.yaml differs from
// the one its last install came from, as web.ts builds the app whenever apps/web changed. With nothing changed that
// costs one `git rev-parse`. Only Node's own modules load before the install; the server's come after it (server.ts).
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const STAMP = join(REPO, "node_modules", ".desk-lock"); // the lockfile's git blob the last install came from

function lockfile(): string {
  try {
    return execFileSync("git", ["rev-parse", "HEAD:pnpm-lock.yaml"], { cwd: REPO, encoding: "utf8" }).trim();
  } catch {
    return ""; // not a git checkout: install by hand
  }
}

const lock = lockfile();
if (lock && !(existsSync(STAMP) && readFileSync(STAMP, "utf8") === lock)) {
  // pnpm comes from volta, which desk.service's PATH may leave out.
  const env = { ...process.env, PATH: `${join(homedir(), ".volta", "bin")}:${process.env.PATH ?? ""}` };
  try {
    execFileSync("pnpm", ["install", "--frozen-lockfile", "--prefer-offline"], { cwd: REPO, env, stdio: "inherit", timeout: 300_000 });
    writeFileSync(STAMP, lock);
  } catch (error) {
    console.error(`Installing desk's packages failed, so desk runs on those it has: ${error}`);
  }
}

await import("./server.ts");
