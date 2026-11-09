// The files attached in a composer that Claude does not take inline as an image, such as a PDF, a CSV or a zip: desk
// keeps each in UPLOADS_DIR/<session>/, and the message names it by its path on a line of its own, which Claude reads
// with its tools, as it reads a file dragged into Claude Code's terminal. The chat shows those lines as the files' names.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { UPLOADS_DIR } from "./config.ts";

export interface Upload {
  name: string;
  data: string; // base64
}

const LINE = "Attached file: ";

// Keep the files and give the message its lines for them, after what was typed.
export function attach(session: string, text: string, files: Upload[]): string {
  if (!files.length) return text;
  const dir = join(UPLOADS_DIR, session);
  mkdirSync(dir, { recursive: true });
  const paths = files.map((f) => {
    const name = f.name.replace(/[\\/\0]/g, "_").slice(-120);
    const path = free(dir, name.replace(/^\.+$/, "") || "file");
    writeFileSync(path, Buffer.from(f.data, "base64"));
    return path;
  });
  return [text, paths.map((p) => LINE + p).join("\n")].filter(Boolean).join("\n\n");
}

// The name, or the name with (2), (3)… before its extension when the session has a file of that name already.
function free(dir: string, name: string): string {
  const ext = extname(name), stem = name.slice(0, name.length - ext.length);
  for (let n = 1; ; n++) {
    const path = join(dir, n === 1 ? name : `${stem} (${n})${ext}`);
    if (!existsSync(path)) return path;
  }
}

// A message as the user typed it, and the names of the files attached to it.
export function split(text: string): { text: string; files: string[] } {
  const lines = text.split("\n"), files: string[] = [];
  while (lines.length && lines.at(-1)!.startsWith(LINE)) files.unshift(basename(lines.pop()!.slice(LINE.length)));
  return { text: lines.join("\n").trim(), files };
}
