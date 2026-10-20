// A date as Linear's project dates are: a day, or a month, quarter, half-year or year, as sure as the plan is. "Select
// start and target dates that match your level of certainty. Options are available to choose a year, half-year,
// quarter, month or precise day" (linear.app/docs/projects#timeframes). desk keeps one in a text whose form says which:
// 2026-11-08, 2026-11, 2026-Q4, 2026-H2 or 2026. The app keeps a copy of this file (apps/web/src/lib/periods.ts).

export type Period = { kind: "day" | "month" | "quarter" | "half" | "year"; start: Date; end: Date };

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const pad = (n: number) => String(n).padStart(2, "0");
const day = (y: number, m: number, d: number) => new Date(y, m, d);

// The period a stored text names, or null when it names none.
export function period(text: string | null | undefined): Period | null {
  const m = /^(\d{4})(?:-(?:(\d{2})(?:-(\d{2}))?|Q([1-4])|H([12])))?$/.exec(text ?? "");
  if (!m) return null;
  const y = +m[1];
  if (m[3]) {
    const d = day(y, +m[2] - 1, +m[3]);
    return d.getMonth() === +m[2] - 1 ? { kind: "day", start: d, end: d } : null;
  }
  if (m[2]) return +m[2] >= 1 && +m[2] <= 12 ? { kind: "month", start: day(y, +m[2] - 1, 1), end: day(y, +m[2], 0) } : null;
  if (m[4]) return { kind: "quarter", start: day(y, (+m[4] - 1) * 3, 1), end: day(y, +m[4] * 3, 0) };
  if (m[5]) return { kind: "half", start: day(y, (+m[5] - 1) * 6, 1), end: day(y, +m[5] * 6, 0) };
  return { kind: "year", start: day(y, 0, 1), end: day(y, 12, 0) };
}

const ord = (n: number) => `${n}${n % 10 === 1 && n !== 11 ? "st" : n % 10 === 2 && n !== 12 ? "nd" : n % 10 === 3 && n !== 13 ? "rd" : "th"}`;

// How a chip writes it, as Linear's do: Apr 21st (with its year when not this one), May 2027, Q4 2026, H2 2026, 2027.
export function label(text: string | null | undefined, now = new Date()): string {
  const p = period(text);
  if (!p) return "";
  const y = p.start.getFullYear();
  if (p.kind === "day") return `${NAMES[p.start.getMonth()]} ${ord(p.start.getDate())}${y === now.getFullYear() ? "" : `, ${y}`}`;
  if (p.kind === "month") return `${NAMES[p.start.getMonth()]} ${y}`;
  if (p.kind === "quarter") return `Q${p.start.getMonth() / 3 + 1} ${y}`;
  if (p.kind === "half") return `H${p.start.getMonth() / 6 + 1} ${y}`;
  return String(y);
}

// Whether the period has ended before today: a target date passed.
export const passed = (text: string | null | undefined, now = new Date()) => {
  const p = period(text);
  return p !== null && p.end < day(now.getFullYear(), now.getMonth(), now.getDate());
};

// What a person typed, as Linear's date box takes it ("Try: May 2027, Q4, 20/05/2027"), in desk's form; null when it
// reads as no date. A quarter, half or month with no year is the next one not yet over.
export function parse(typed: string, now = new Date()): string | null {
  const t = typed.trim().toLowerCase().replace(/,/g, " ").replace(/\s+/g, " ");
  if (!t) return null;
  if (period(typed.trim())) return typed.trim();
  const year = now.getFullYear();
  const next = (make: (y: number) => string) => (passed(make(year), now) ? make(year + 1) : make(year));
  let m: RegExpExecArray | null;
  if ((m = /^q([1-4])(?: (\d{4}))?$/.exec(t))) return m[2] ? `${m[2]}-Q${m[1]}` : next((y) => `${y}-Q${m![1]}`);
  if ((m = /^(\d{4}) q([1-4])$/.exec(t))) return `${m[1]}-Q${m[2]}`;
  if ((m = /^h([12])(?: (\d{4}))?$/.exec(t))) return m[2] ? `${m[2]}-H${m[1]}` : next((y) => `${y}-H${m![1]}`);
  if ((m = /^(\d{4}) h([12])$/.exec(t))) return `${m[1]}-H${m[2]}`;
  if ((m = /^(\d{1,2})[/.](\d{1,2})[/.](\d{4})$/.exec(t))) return valid(`${m[3]}-${pad(+m[2])}-${pad(+m[1])}`);
  const month = (word: string) => MONTHS.findIndex((name) => word.startsWith(name));
  if ((m = /^([a-z]{3,})(?: (\d{4}))?$/.exec(t)) && month(m[1]) >= 0)
    return m[2] ? `${m[2]}-${pad(month(m[1]) + 1)}` : next((y) => `${y}-${pad(month(m![1]) + 1)}`);
  if ((m = /^([a-z]{3,}) (\d{1,2})(?:st|nd|rd|th)?(?: (\d{4}))?$/.exec(t)) && month(m[1]) >= 0)
    return valid(`${m[3] ?? year}-${pad(month(m[1]) + 1)}-${pad(+m[2])}`);
  if ((m = /^(\d{1,2})(?:st|nd|rd|th)? ([a-z]{3,})(?: (\d{4}))?$/.exec(t)) && month(m[2]) >= 0)
    return valid(`${m[3] ?? year}-${pad(month(m[2]) + 1)}-${pad(+m[1])}`);
  return null;
}

const valid = (text: string) => (period(text) ? text : null);
