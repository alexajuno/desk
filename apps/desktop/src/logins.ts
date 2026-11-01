// The user's logins in Claude's tabs: each time the app starts, the cookies of the user's own Chrome come into the
// tabs' store, read as that Chrome reads them, so a page Claude opens, or the user in a chat's Browser, is signed in
// where the user is (desk issue "desk as a desktop app, as Linear's, with a real Chrome inside", 1 Nov). Where both
// hold a cookie, Chrome's wins; one the tabs made alone stays. Only cookies come, not a page's own storage, which a
// newer Chrome keeps in a form the app's may not read.
//
// Chrome on Linux locks a cookie's value with AES-128-CBC, under a key made from "peanuts" (v10) or from a password it
// keeps in the user's keyring as "Chrome Safe Storage" (v11), and since its database's version 24 puts the SHA-256 of
// the cookie's host before the value. The tabs' store locks them again, with the app's own key in the keyring
// (../fuses.ts, and main.ts's password-store).
import type { WebContents } from "electron";
import { execFile } from "node:child_process";
import { createDecipheriv, pbkdf2Sync } from "node:crypto";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";

const PROFILE = process.env.DESK_CHROME_PROFILE || join(homedir(), ".config/google-chrome/Profile 2"); // as chrome-agent's
const EPOCH = 11644473600; // seconds from 1601, Chrome's, to 1970
const SAME_SITE = ["None", "Lax", "Strict"];
const PRIORITY = ["Low", "Medium", "High"];
const SCHEME = ["Unset", "NonSecure", "Secure"];

type Row = {
  host_key: string; name: string; value: string; encrypted_value: Uint8Array; path: string; expires: number;
  has_expires: number; is_secure: number; is_httponly: number; samesite: number; priority: number;
  source_scheme: number; source_port: number; top_frame_site_key: string; has_cross_site_ancestor: number;
};

// The user's cookies into the store of the page, one of Claude's tabs' own; how many came.
export async function bring(page: WebContents) {
  const cookies = await read();
  page.debugger.attach("1.3");
  try {
    // One at a time, since DevTools sets none of a list when one is refused
    const set = await Promise.allSettled(cookies.map((c) => page.debugger.sendCommand("Network.setCookie", c)));
    return set.filter((s) => s.status === "fulfilled").length;
  } finally {
    page.debugger.detach();
  }
}

async function read() {
  const keys: Record<string, Buffer> = { v10: key("peanuts") };
  try {
    keys.v11 = key((await promisify(execFile)("secret-tool", ["lookup", "application", "chrome"])).stdout);
  } catch {} // no keyring: only the v10 cookies come
  // A copy, since Chrome holds its own open; in the user's own runtime folder, which only they reach
  const dir = mkdtempSync(join(process.env.XDG_RUNTIME_DIR || tmpdir(), "desk-logins-"));
  let rows: Row[], version: number;
  try {
    copyFileSync(join(PROFILE, "Cookies"), join(dir, "Cookies"));
    const db = new DatabaseSync(join(dir, "Cookies"), { readOnly: true });
    version = Number((db.prepare("SELECT value FROM meta WHERE key = 'version'").get() as { value: string }).value);
    rows = db.prepare(`SELECT host_key, name, value, encrypted_value, path, expires_utc / 1000000 - ${EPOCH} AS expires,
      has_expires, is_secure, is_httponly, samesite, priority, source_scheme, source_port, top_frame_site_key,
      has_cross_site_ancestor FROM cookies`).all() as Row[]; // the times in microseconds overflow a JS number
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const now = Date.now() / 1000;
  return rows.filter((r) => !r.has_expires || r.expires > now).flatMap((r) => {
    const value = r.encrypted_value.length ? open(Buffer.from(r.encrypted_value), keys, version >= 24) : r.value;
    if (value === undefined) return [];
    const scheme = r.is_secure ? "https" : "http";
    return [{
      name: r.name, value, path: r.path, secure: Boolean(r.is_secure), httpOnly: Boolean(r.is_httponly),
      // A host's own cookie has no domain, and one for its subdomains too starts with a dot
      ...(r.host_key.startsWith(".") ? { domain: r.host_key } : { url: `${scheme}://${r.host_key}${r.path}` }),
      sameSite: SAME_SITE[r.samesite], expires: r.has_expires ? r.expires : undefined,
      priority: PRIORITY[r.priority], sourceScheme: SCHEME[r.source_scheme], sourcePort: r.source_port,
      partitionKey: r.top_frame_site_key ? { topLevelSite: r.top_frame_site_key, hasCrossSiteAncestor: Boolean(r.has_cross_site_ancestor) } : undefined,
    }];
  });
}

const key = (password: string) => pbkdf2Sync(password, "saltysalt", 1, 16, "sha1");

function open(locked: Buffer, keys: Record<string, Buffer>, hashed: boolean) {
  const key = keys[locked.subarray(0, 3).toString()];
  if (!key) return undefined;
  try {
    const d = createDecipheriv("aes-128-cbc", key, Buffer.alloc(16, " "));
    return Buffer.concat([d.update(locked.subarray(3)), d.final()]).subarray(hashed ? 32 : 0).toString();
  } catch {
    return undefined;
  }
}
