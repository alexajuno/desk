// desk's window (apps/native: Rust, GPUI), which desk-app.service runs from ~/.cache/desk/native-target since Electron's
// app left on 8 Nov (desk issue "Rebuild desk as a native Rust app like Zed, off Electron").
//
// As web.ts builds the web app, desk builds the window when it starts, whenever the window's committed sources differ
// from the ones its last build came from, but in the background: a build from nothing took about ten minutes, a change
// a minute or two (8 Nov). The window then starts again on the new build if it is hidden; one in use keeps running the
// last until its next start, so that a landing never closes it under you. A test desk builds none, since
// desk-app.service runs the user's window, not a test's.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HOME, REPO, TEST } from "./config.ts";
import { run } from "./proc.ts";
import * as window from "./window.ts";

const TARGET = join(HOME, ".cache", "desk", "native-target");
const STAMP = join(TARGET, ".source"); // the git tree of apps/native the build in TARGET was made from
const CARGO = join(HOME, ".cargo", "bin", "cargo");

// The tree apps/native has in the commit checked out: it changes exactly when the window's code does.
const source = async () => (await run(["git", "rev-parse", "HEAD:apps/native"], { cwd: REPO })).stdout.trim();

// The window's process, while desk-app.service runs it.
async function windowPid(): Promise<number> {
  const said = await run(["systemctl", "--user", "show", "-p", "MainPID", "--value", "desk-app.service"]).catch(() => null);
  return Number(said?.stdout.trim() ?? 0);
}

// Build the window if its sources changed since the last build; a failed build leaves the last one running, and the log
// says why.
export async function build() {
  if (TEST || !existsSync(CARGO)) return;
  const tree = await source();
  if (!tree || (existsSync(STAMP) && readFileSync(STAMP, "utf8") === tree)) return;
  console.log("desk is building its window (apps/native) in the background");
  const env = { ...process.env, CARGO_TARGET_DIR: TARGET };
  const done = await run(["nice", "-n", "19", CARGO, "build", "--release", "-j", "4"], { cwd: join(REPO, "apps", "native"), env, timeout: 3600 })
    .catch((error: Error) => ({ code: 1, stdout: "", stderr: String(error) }));
  if (done.code) {
    console.error(`Building the window failed:\n${(done.stdout + done.stderr).slice(-4000)}`);
    return;
  }
  writeFileSync(STAMP, tree);
  const pid = await windowPid();
  if (pid && (await window.workspaceOf(pid).catch(() => null)) === "special:desk") {
    await run(["systemctl", "--user", "restart", "desk-app.service"]).catch(() => null);
  }
  console.log("desk built its window");
}
