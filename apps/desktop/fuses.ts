// Electron's fuses, set in its binary after each install (this package's postinstall): EnableCookieEncryption, so that
// the logins in Claude's tabs (src/logins.ts) sit on disk locked with a key in the user's keyring, as Chrome's do, and
// not as plain text, Electron's default. A copy is set and moved in, so that a running app keeps its own binary, which
// Linux refuses to write, and a binary pnpm's store shares with another checkout stays as it is.
import { flipFuses, FuseState, FuseV1Options, FuseVersion, getCurrentFuseWire } from "@electron/fuses";
import electron from "electron";
import { copyFile, rename } from "node:fs/promises";

const binary = electron as unknown as string; // the electron package gives its binary's path to Node
if ((await getCurrentFuseWire(binary))[FuseV1Options.EnableCookieEncryption] !== FuseState.ENABLE) {
  const copy = `${binary}.fuses`;
  await copyFile(binary, copy);
  await flipFuses(copy, { version: FuseVersion.V1, [FuseV1Options.EnableCookieEncryption]: true });
  await rename(copy, binary);
  console.log("desktop: Electron saves cookies encrypted");
}
