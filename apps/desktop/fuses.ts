// Electron for desk's app, made after each install (this package's postinstall): a copy of the electron package's dist
// in ~/.cache/desk/electron-<version>, which the app runs from through the link ~/.cache/desk/electron (desk-app.service,
// bin/desk-app). pnpm install replaces the package's folder in node_modules, and desk runs one itself whenever the lock
// file changed (apps/server/src/main.ts): an app running from there lost its folder, and every process it started after
// failed on "libffmpeg.so: cannot open shared object file", so a tab that needed one hung, and with it every Playwright
// connect through the relay (2 Nov, desk issue "Browser relay times out"). A version's copy is never written again once
// made, and a new version only moves the link, which the running app does not read: it runs the new one once restarted.
//
// The copy's binary has Electron's EnableCookieEncryption fuse set, so that the logins in Claude's tabs (src/logins.ts)
// sit on disk locked with a key in the user's keyring, as Chrome's do, and not as plain text, Electron's default.
import { flipFuses, FuseState, FuseV1Options, FuseVersion, getCurrentFuseWire } from "@electron/fuses";
import electron from "electron";
import { cp, mkdir, rename, rm, stat, symlink } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

const binary = electron as unknown as string; // the electron package gives its binary's path to Node
const { version } = createRequire(import.meta.url)("electron/package.json") as { version: string };
const home = join(homedir(), ".cache/desk"), name = `electron-${version}`, copy = join(home, name);
const fused = async (bin: string) => (await getCurrentFuseWire(bin))[FuseV1Options.EnableCookieEncryption] === FuseState.ENABLE;

if (!(await stat(join(copy, basename(binary))).catch(() => null))) {
  await mkdir(home, { recursive: true });
  const making = `${copy}.${process.pid}`; // made whole beside it, then moved in, so a copy is never half there
  await cp(dirname(binary), making, { recursive: true, verbatimSymlinks: true });
  const bin = join(making, basename(binary));
  if (!(await fused(bin))) await flipFuses(bin, { version: FuseVersion.V1, [FuseV1Options.EnableCookieEncryption]: true });
  await rename(making, copy).catch(async (e) => {
    await rm(making, { recursive: true, force: true }); // another install made it meanwhile
    if (!(await stat(copy).catch(() => null))) throw e;
  });
  console.log(`desktop: Electron ${version} copied to ${copy}, saving cookies encrypted`);
}
const link = join(home, "electron"), next = `${link}.${process.pid}`;
await symlink(name, next);
await rename(next, link);
