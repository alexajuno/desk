// Running other programs: git, claude, kitty, hyprctl, systemd-run. As Python's subprocess.run with capture_output.
import { execFile, spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";

export interface Ran {
  code: number;
  stdout: string;
  stderr: string;
}

export class Timeout extends Error {}

export function run(argv: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string; timeout?: number } = {}): Promise<Ran> {
  return new Promise((resolve, reject) => {
    const child = execFile(argv[0], argv.slice(1), {
      cwd: opts.cwd, env: opts.env, timeout: (opts.timeout ?? 0) * 1000, maxBuffer: 64 * 1024 * 1024, encoding: "utf8",
    }, (error, stdout, stderr) => {
      if (error && (error as NodeJS.ErrnoException).code === "ENOENT") return reject(error);
      if (error && error.killed && opts.timeout) return reject(new Timeout(`${argv[0]} timed out after ${opts.timeout}s`));
      const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
      resolve({ code, stdout, stderr });
    });
    if (opts.input !== undefined) child.stdin?.end(opts.input);
  });
}

// A program started and left to run on its own, its output dropped (Popen with start_new_session).
export function detach(argv: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string } = {}) {
  const child = spawn(argv[0], argv.slice(1), { cwd: opts.cwd, env: opts.env, detached: true, stdio: [opts.input === undefined ? "ignore" : "pipe", "ignore", "ignore"] });
  if (opts.input !== undefined) child.stdin?.end(opts.input);
  child.unref();
}

// shutil.which: the program's path on PATH, or null.
export function which(name: string, path = process.env.PATH ?? ""): string | null {
  for (const dir of path.split(delimiter)) {
    if (!dir) continue;
    try {
      accessSync(join(dir, name), constants.X_OK);
      return join(dir, name);
    } catch {
      // not here
    }
  }
  return null;
}

// shlex.join: the words as one line a POSIX shell reads back as the same words.
export const shJoin = (words: string[]) => words.map((w) => (/^[\w@%+=:,./-]+$/.test(w) ? w : `'${w.replace(/'/g, `'"'"'`)}'`)).join(" ");

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
