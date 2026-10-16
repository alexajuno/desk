// issue.md and project.md: YAML front matter, then the body (desk/issues.py, _parse and save). The front matter is
// read as YAML 1.1, as PyYAML read it, and written as PyYAML's safe_dump(sort_keys=False, allow_unicode=True) wrote
// it, so files written by either read the same and the data folder's git history shows no churn.
import { parse } from "yaml";

const FRONT_MATTER = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;

export function split(text: string): { meta: Record<string, unknown>; body: string } {
  const m = FRONT_MATTER.exec(text);
  if (!m) return { meta: {}, body: text };
  return { meta: (parse(m[1], { version: "1.1" }) as Record<string, unknown> | null) ?? {}, body: m[2] };
}

// A value as Python's str() gave it: YAML 1.1 reads an unquoted 2026-10-14 20:40:09 as a timestamp, which PyYAML gave
// as a datetime and issues.py turned into text with str(): "2026-10-14 20:40:09".
export function asText(value: unknown): string {
  if (value instanceof Date) {
    const pad = (n: number) => String(n).padStart(2, "0");
    const d = value;
    const date = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
    const time = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
    return d.getUTCHours() || d.getUTCMinutes() || d.getUTCSeconds() ? `${date} ${time}` : date;
  }
  return String(value);
}

// --- PyYAML's emitter, for a flat map of strings (yaml/emitter.py and resolver.py, PyYAML 6) -------------------------

// The YAML 1.1 implicit types: a string that reads as one of them is quoted, so it reads back as a string.
const IMPLICIT = [
  /^(?:yes|Yes|YES|no|No|NO|true|True|TRUE|false|False|FALSE|on|On|ON|off|Off|OFF)$/,
  /^(?:[-+]?(?:[0-9][0-9_]*)\.[0-9_]*(?:[eE][-+][0-9]+)?|\.[0-9][0-9_]*(?:[eE][-+][0-9]+)?|[-+]?[0-9][0-9_]*(?::[0-5]?[0-9])+\.[0-9_]*|[-+]?\.(?:inf|Inf|INF)|\.(?:nan|NaN|NAN))$/,
  /^(?:[-+]?0b[0-1_]+|[-+]?0[0-7_]+|[-+]?(?:0|[1-9][0-9_]*)|[-+]?0x[0-9a-fA-F_]+|[-+]?[1-9][0-9_]*(?::[0-5]?[0-9])+)$/,
  /^(?:<<)$/,
  /^(?:~|null|Null|NULL|)$/,
  /^(?:[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]|[0-9][0-9][0-9][0-9]-[0-9][0-9]?-[0-9][0-9]?(?:[Tt]|[ \t]+)[0-9][0-9]?:[0-9][0-9]:[0-9][0-9](?:\.[0-9]*)?(?:[ \t]*(?:Z|[-+][0-9][0-9]?(?::[0-9][0-9])?))?)$/,
  /^(?:=)$/,
];

const WIDTH = 80; // PyYAML's best_width
const INDENT = 2;

// Whether PyYAML would write the string plain (emitter.analyze_scalar, for a block mapping's value).
function plainAllowed(text: string): boolean {
  if (!text || IMPLICIT.some((re) => re.test(text))) return false;
  if (text.startsWith(" ") || text.endsWith(" ")) return false;
  if (/^[-?:]$/.test(text) || /^[-?:][ ]/.test(text)) return false;
  if ("#,[]{}&*!|>'\"%@`".includes(text[0])) return false;
  if (/[\n\x85\u2028\u2029]/.test(text)) return false;
  if (/: |:$| #/.test(text)) return false;
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)) return false;
  // Two spaces in a row, or a space before or after a line break, keep a plain scalar from being split there; PyYAML
  // still writes it plain, it only cannot fold there.
  return true;
}

// Write words separated by single spaces, breaking the line at a space once the column passed WIDTH, as PyYAML's
// write_plain and write_single_quoted do. Returns the text and the column it ends at.
function fold(text: string, column: number, quoted: boolean): string {
  let out = "", col = column;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const single = c === " " && text[i - 1] !== " " && text[i + 1] !== " ";
    if (single && col > WIDTH && (!quoted || (i !== 0 && i !== text.length - 1))) {
      out += `\n${" ".repeat(INDENT)}`;
      col = INDENT;
      continue;
    }
    const piece = quoted && c === "'" ? "''" : c;
    out += piece;
    col += [...piece].length;
  }
  return out;
}

export function dump(meta: Record<string, string>): string {
  return Object.entries(meta).map(([key, value]) => {
    const start = key.length + 2;
    return plainAllowed(value) ? `${key}: ${fold(value, start, false)}` : `${key}: '${fold(value, start + 1, true)}'`;
  }).join("\n");
}
