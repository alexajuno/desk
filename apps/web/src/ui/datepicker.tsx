// Linear's date picker, as its project's Target date chip opens it, measured on linear.app on 2026-10-20 at 2x, dark: a
// 304px popover with its name over a box that reads a typed date ("Try: May 2027, Q4, 20/05/2027"), then five pills, Day,
// Month, Quarter, Half-year and Year, over what each picks from: a month's calendar, Mondays first, or each year's months,
// quarters or halves, or the years. A project's dates take any of them; an issue's due date only a day (kinds). The
// app reads what was typed as the server does (lib/periods.ts), so a pick and a typed date reach set in one form.
import { useRef, useState } from "react";
import { dayText, monthText, MONTH_NAMES, parse, period } from "../lib/periods";
import { keyOf } from "../lib/keys";
import { closeMenu, openMenu } from "./menu";
import { toast } from "./toast";

type Kind = "day" | "month" | "quarter" | "half" | "year";
const KINDS: [Kind, string][] = [["day", "Day"], ["month", "Month"], ["quarter", "Quarter"], ["half", "Half-year"], ["year", "Year"]];
const WEEK = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];

export interface DateOptions {
  anchor: Element;
  title: string; // Target date, Start date, Due date
  current: string | null;
  kinds?: Kind[];
  set: (text: string | null) => unknown; // null takes the date out
}

export function datePicker(o: DateOptions) {
  openMenu({ anchor: o.anchor, className: "date-pick", items: () => [], render: () => <DatePick o={o} /> });
}

function DatePick({ o }: { o: DateOptions }) {
  const kinds = o.kinds ?? KINDS.map(([k]) => k);
  const was = period(o.current), today = new Date();
  const [kind, setKind] = useState<Kind>(was && kinds.includes(was.kind) ? was.kind : kinds[0]);
  const [month, setMonth] = useState(() => { const d = was?.start ?? today; return new Date(d.getFullYear(), d.getMonth(), 1); });
  const [typed, setTyped] = useState("");
  const composing = useRef(false);
  const pick = (text: string | null) => { closeMenu(); o.set(text); };
  const on = (text: string) => o.current === text;
  const years = [0, 1, 2].map((n) => today.getFullYear() + n);

  // The month's calendar: whole weeks, Monday first, the days outside it greyed.
  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  const lead = (first.getDay() + 6) % 7;
  const days = Array.from({ length: Math.ceil((lead + new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate()) / 7) * 7 },
    (_, n) => new Date(month.getFullYear(), month.getMonth(), n - lead + 1));
  const same = (a: Date, b: Date) => a.toDateString() === b.toDateString();

  const cell = (text: string, label: string) => (
    <button key={text} type="button" className={`dp-cell${on(text) ? " on" : ""}`} onClick={() => pick(text)}>{label}</button>
  );

  return (
    <div className="date-pick-in">
      <div className="date-pick-head">
        <label>{o.title}</label>
        <input autoFocus type="text" placeholder={kinds.length > 1 ? "Try: May 2027, Q4, 20/05/2027" : "Try: 20/05/2027, Nov 8"} value={typed}
          onChange={(e) => setTyped(e.target.value)}
          onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}
          onKeyDown={(e) => {
            if (keyOf(e) !== "Enter" || composing.current || e.nativeEvent.isComposing) return;
            e.preventDefault();
            const found = typed.trim() && parse(typed);
            if (found && kinds.includes(period(found)!.kind)) pick(found);
            else if (typed.trim()) toast(`“${typed.trim()}” is no ${kinds.length > 1 ? "date" : "day"}: try ${kinds.length > 1 ? "May 2027, Q4 or 20/05/2027" : "20/05/2027 or Nov 8"}`);
          }} />
        {kinds.length > 1 && (
          <div className="date-kinds">
            {KINDS.filter(([k]) => kinds.includes(k)).map(([k, label]) => (
              <button key={k} type="button" className={k === kind ? "on" : ""} onClick={() => setKind(k)}>{label}</button>
            ))}
          </div>
        )}
      </div>
      <div className="date-pick-body">
        {kind === "day" && (
          <>
            <div className="cal-head">
              <span>{`${["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"][month.getMonth()]} ${month.getFullYear()}`}</span>
              <button type="button" className="cal-step" aria-label="Previous month" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}>
                <svg width="16" height="16" viewBox="0 0 16 16"><path d="M10 4L6 8l4 4" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
              </button>
              <button type="button" className="cal-step" aria-label="Next month" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}>
                <svg width="16" height="16" viewBox="0 0 16 16"><path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
              </button>
            </div>
            <div className="cal">
              {WEEK.map((w, n) => <span key={w} className={`cal-week${n > 4 ? " weekend" : ""}`}>{w}</span>)}
              {days.map((d, n) => (
                <button key={n} type="button" className={`cal-day${n % 7 > 4 ? " weekend" : ""}${d.getMonth() !== month.getMonth() ? " out" : ""}${same(d, today) ? " today" : ""}${on(dayText(d)) ? " on" : ""}`}
                  onClick={() => pick(dayText(d))}><span>{d.getDate()}</span></button>
              ))}
            </div>
          </>
        )}
        {kind === "month" && years.map((y) => (
          <div key={y} className="date-year"><span>{y}</span><div className="date-grid three">{MONTH_NAMES.map((name, m) => cell(monthText(y, m), name))}</div></div>
        ))}
        {kind === "quarter" && years.map((y) => (
          <div key={y} className="date-year"><span>{y}</span><div className="date-grid four">{[1, 2, 3, 4].map((q) => cell(`${y}-Q${q}`, `Q${q}`))}</div></div>
        ))}
        {kind === "half" && years.map((y) => (
          <div key={y} className="date-year"><span>{y}</span><div className="date-grid two">{[1, 2].map((h) => cell(`${y}-H${h}`, `H${h}`))}</div></div>
        ))}
        {kind === "year" && (
          <div className="date-year"><div className="date-grid three">{[0, 1, 2, 3, 4, 5].map((n) => cell(String(today.getFullYear() + n), String(today.getFullYear() + n)))}</div></div>
        )}
        {o.current && <button type="button" className="date-clear" onClick={() => pick(null)}>Remove date</button>}
      </div>
    </div>
  );
}
