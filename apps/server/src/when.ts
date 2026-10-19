// Times as desk writes them (ported from desk/app.py): short dates, ages as Linear's Inbox writes them, and how long a wait lasted.
// Times are local, as Python's naive datetimes were.

// "2026-10-16T19:26:20" (or "2026-10-16 19:26:20") read as local time.
export const parseLocal = (iso: string) => new Date(iso.replace(" ", "T"));

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// strftime("%b %-d"): "Oct 16".
export const shortDate = (iso: string | null | undefined) => {
  if (!iso) return "";
  const d = parseLocal(String(iso));
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
};

// strftime("%b %-d, %H:%M"): "Oct 16, 19:26".
export const dayAndTime = (d: Date) => `${MONTHS[d.getMonth()]} ${d.getDate()}, ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;

// How long ago, as Linear's Inbox writes it: now, 5m, 13h, 3d, 2w.
export function ago(when: Date): string {
  const seconds = (Date.now() - when.getTime()) / 1000;
  for (const [size, unit] of [[604800, "w"], [86400, "d"], [3600, "h"], [60, "m"]] as const)
    if (seconds >= size) return `${Math.floor(seconds / size)}${unit}`;
  return "now";
}

const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

// How long a wait has lasted, in days, as a wait is chased: today, then 3d, 2w.
export function waited(iso: string | null | undefined): string {
  const when = iso ? parseLocal(iso) : new Date();
  return sameDay(when, new Date()) ? "today" : ago(when);
}

// "today 08:00", "tomorrow 08:00", "yesterday 08:00", else "Oct 25, 20:00": when an automation fires next, or last fired.
export function nearDay(d: Date): string {
  const time = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const today = new Date(), days = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() -
    new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()) / 86_400_000);
  const word = ({ [-1]: "yesterday", 0: "today", 1: "tomorrow" } as Record<number, string>)[days];
  return word ? `${word} ${time}` : dayAndTime(d);
}
