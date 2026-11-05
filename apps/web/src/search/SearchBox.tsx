// The search, one box for everything over the page you are on (step 1.1): the O menus' box (frame/open.tsx, desk.css's
// .menu.command), 720px wide, 13% down the window, with no dimming (step 1.8). Under what you type, a tab per kind, each
// with how many it found and dimmed when it found none; Tab and Shift Tab walk them, and a kind's first letter then Tab
// goes to its tab, a for All (step 1.2). All shows a group per kind, Chats first, each its best 5 under a heading that opens its tab
// (step 1.5); before anything is typed, each tab lists what is live (step 1.4). The server finds every kind but the
// settings (pages.ts, searchPage), which the app finds itself (settings.ts). The arrows move, Enter opens the thing
// where it lives, and Esc or a click outside closes the box, leaving you where you were. A filter is typed into the bar
// as key:value, state:done, by the names each kind keeps its fields under (the server's fields.ts); Space or Enter at
// its end turns it into a chip at the bar's start, red in a kind that has no such field, as Issues have no status, where
// it is searched as words; Backspace right after the chips turns the last one back into text (the search issue's step
// 1.2). As a filter is typed, a menu under it offers the fields its letters start, then the field's values, the one in
// focus greyed after the caret; Tab takes it, Enter takes a value, the arrows move in it, Esc closes it (mockup C). The
// chips and the words go to the server as one search, which reads the filters itself. / and the sidebar's Search open
// it on Chats with nothing typed, the kind searched most (step 1.2). A chat's title is found here, on each key, and what
// the server finds besides joins below it, never moving the row in focus (chats.ts).
import { action, makeObservable, observable } from "mobx";
import { observer } from "mobx-react-lite";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { go } from "../app/nav";
import { teamPath } from "../frame/open";
import type { IssueRow } from "../lib/desk";
import { keyOf } from "../lib/keys";
import { CROSS, iconOf } from "../lists/parts";
import { openSession } from "../sessions/Dock";
import { issues } from "../store/issues";
import { GLYPH, MilestoneIcon, ProjectStatusIcon, Ring, StateIcon } from "../ui/icons";
import { closeMenu } from "../ui/menu";
import { catchKeys, takeCaught } from "./catcher";
import { catalog, findChats } from "./chats";
import { findSettings } from "./settings";

type Kind = "chats" | "issues" | "projects" | "teams" | "milestones" | "settings";
const KINDS: { kind: Kind; name: string }[] = [
  { kind: "chats", name: "Chats" },
  { kind: "issues", name: "Issues" },
  { kind: "projects", name: "Projects" },
  { kind: "teams", name: "Teams" },
  { kind: "milestones", name: "Milestones" },
  { kind: "settings", name: "Settings" },
];
// The letter that, then Tab, picks a kind: its name's first, and a for All.
const letterOf = (name: string) => name[0].toLowerCase();
const BEST = 5; // each group's rows in All

// One row of the answer, as pages.ts's searchPage and settings.ts make them: its title and the line that matched are
// HTML, the words found marked.
interface Hit {
  kind: "chat" | "issue" | "project" | "team" | "milestone" | "setting";
  key: string;
  title: string;
  snippet: string;
  session?: string; // a chat's
  folder?: string;
  age?: string;
  issue?: IssueRow | Pick<IssueRow, "slug" | "state"> | null; // an issue's, or a chat's issue: only these two from the browser's list
  team?: { slug: string; title: string } | null; // its team, or a team itself
  date?: string;
  project?: { slug: string; title?: string; status?: string; progress?: number }; // a project, or a milestone's project
  open?: number; // a team's open issues
  milestone?: { id: string; target_label: string; progress: number; current: boolean };
  section?: string; // a setting's page
  path?: string; // where a setting opens
}
interface Group { kind: Kind; count: number; hits: Hit[] }

// Each kind's fields, as the server's fields.ts names them, asked for as the box opens (step 2.1): which key:value
// turns into a chip, and the labels and icons its values show.
interface Value { value: string; label: string; icon: string | null }
interface Field { name: string; type: "set" | "date" | "number"; values: Value[] }
type Fields = Partial<Record<Kind, Field[]>>;
let known: Fields = {}; // as the box last had them, so that it draws its chips at once as it opens again

// A key's field: the lit kind's, or in All any kind's.
const fieldOf = (fields: Fields, kind: Kind | "", key: string) =>
  (kind ? [kind] : KINDS.map((k) => k.kind)).flatMap((k) => fields[k] ?? []).find((f) => f.name === key);
// Every kind's field of that name, the lit kind's first: state is an issue's, a chat's and a team's.
const fieldsNamed = (fields: Fields, kind: Kind | "", key: string) =>
  KINDS.map((k) => k.kind).sort((a, b) => Number(b === kind) - Number(a === kind)).flatMap((k) => fields[k] ?? []).filter((f) => f.name === key);

// A filter as typed, key:value, as fields.ts's read takes it: `-` before it is "is not", and a comma between values
// "either", as GitHub's search has them (step 1.2).
interface Filter { not: boolean; key: string; values: string[] }
const TOKEN = /^(-?)([a-z_]+(?:\.[a-z_]+)?):(.*)$/i;
function filterOf(text: string): Filter | null {
  const m = TOKEN.exec(text), values = m?.[3].split(",").filter(Boolean) ?? [];
  return m && values.length ? { not: !!m[1], key: m[2].toLowerCase(), values } : null;
}
const textOf = (f: Filter) => `${f.not ? "-" : ""}${f.key}:${f.values.join(",")}`;

// What a chip says: the field; is, or is not; before or after for a date, < or > for a number; then its values by their
// labels, joined by "or", with the first one's icon. A value is labelled by the first of the fields that has it.
const COMPARE: Record<string, string> = { "<": "before", ">": "after", "<=": "on or before", ">=": "on or after" };
function chipWords(f: Filter, named: Field[]) {
  const field = named[0], ops = f.values.map((v) => /^(?:<=|>=|<|>)?/.exec(v)![0]);
  const op = field && field.type !== "set" && ops.every((o) => o === ops[0]) ? ops[0] : "";
  const value = (v: string) => named.flatMap((n) => n.values).find((x) => x.value.toLowerCase() === v.toLowerCase());
  const said = !op ? "is" : field.type === "date" ? COMPARE[op] : op;
  return {
    op: !f.not ? said : op ? `not ${said}` : "is not",
    values: f.values.map((v) => value(v)?.label ?? v.slice(op.length)).join(" or "),
    icon: f.values.length < 3 ? iconOf(value(f.values[0])?.icon, true) : null,
  };
}

// What the menu under the caret offers (step 1.2's Typing): the fields a key's first two letters start, the lit kind's
// or in All every kind's, with issue. for a chat's issue's own; after issue., those; after a colon, the field's values
// the letters after it start, then those that hold them, the ones typed already left out. A date offers today, before
// it and after it. Each offer is the whole filter it leaves typed: a field's name and its colon, or the filter with it.
interface Offer { take: string; name: string; label: string; icon?: ReactNode; value: boolean }
interface Menu { start: number; typed: string; heading: string; offers: Offer[] }
const DATES: Value[] = [
  { value: "today", label: "today", icon: "glyph-calendar" },
  { value: "<today", label: "before today", icon: "glyph-calendar" },
  { value: ">today", label: "after today", icon: "glyph-calendar" },
];
const TYPING = /^(-?)([a-z_]*(?:\.[a-z_]*)?)(?::(.*))?$/i;

function menuAt(text: string, caret: number, fields: Fields, kind: Kind | ""): Menu | null {
  if (caret < 0 || /^\S/.test(text.slice(caret))) return null; // a selection, or inside a word
  const start = text.slice(0, caret).search(/\S*$/), typed = text.slice(start, caret), m = TYPING.exec(typed);
  if (!m) return null;
  const [, not, key, after] = m, low = key.toLowerCase(), heading = kind ? KINDS.find((k) => k.kind === kind)!.name : "All";
  if (after === undefined) {
    if (low.length < 2) return null; // one letter picks a kind (step 2.5)
    const own = first((kind ? [kind] : KINDS.map((k) => k.kind)).flatMap((k) => fields[k] ?? []), (f) => f.name);
    const dot = low.indexOf(".");
    const offers: Offer[] = own.filter((f) => f.name.startsWith(low) && f.name.includes(".") === dot >= 0)
      .map((f) => ({ take: `${not}${f.name}:`, name: `${f.name.slice(dot + 1)}:`, label: hint(f), value: false }));
    const its = own.filter((f) => f.name.startsWith("issue."));
    if (dot < 0 && its.length && "issue.".startsWith(low))
      offers.push({ take: `${not}issue.`, name: "issue.", label: its.map((f) => f.name.slice(6)).join(", "), value: false });
    return offers.length ? { start, typed, heading: dot < 0 ? heading : low.slice(0, dot), offers } : null;
  }
  const named = kind ? [fieldOf(fields, kind, low)].filter((f) => !!f) : fieldsNamed(fields, kind, low);
  if (!named.length) return null; // red once a chip: the kind has no such field
  const values = named[0].type === "date" ? DATES : first(named.flatMap((f) => f.values), (v) => v.value);
  const parts = after.split(","), part = parts.pop()!.toLowerCase(), had = new Set(parts.map((p) => p.toLowerCase()));
  const left = values.filter((v) => !had.has(v.value.toLowerCase()));
  const starts = (v: Value) => [v.value, v.label].some((s) => s.toLowerCase().startsWith(part));
  const holds = (v: Value) => !starts(v) && [v.value, v.label].some((s) => s.toLowerCase().includes(part));
  const offers = [...left.filter(starts), ...left.filter(holds)].map((v) => ({
    take: `${not}${named[0].name}:${[...parts, v.value].join(",")}`, name: v.value,
    label: v.label.toLowerCase() === v.value.toLowerCase() ? "" : v.label, icon: iconOf(v.icon, true), value: true,
  }));
  return offers.length ? { start, typed, heading: named[0].name, offers } : null;
}

// The first of each name, in order: in All, state is Chats' before Teams'.
const first = <T,>(all: T[], name: (t: T) => string) => all.filter((t, i) => all.findIndex((u) => name(u) === name(t)) === i);

// What a field's row says at its right: its first values, or the kind of value it takes.
function hint(f: Field) {
  if (f.type !== "set") return f.type === "date" ? "a day" : "a number";
  return f.values.slice(0, 4).map((v) => v.value).join(", ") + (f.values.length > 4 ? ", …" : "");
}

// The width of text in the box's own font, which places the menu under the word typed and the completion after it.
let canvas: HTMLCanvasElement | null = null;
function widthOf(text: string, box: HTMLInputElement) {
  const ctx = (canvas ??= document.createElement("canvas")).getContext("2d")!;
  ctx.font = getComputedStyle(box).font;
  return ctx.measureText(text).width;
}

// What the box opens on: Chats with nothing typed ("wanna search for sessions, usually the most", the user, 1 Nov), or
// an old /search address's words in All (app/routes.tsx).
interface Start { query: string; tab: Kind | "" }

class Search {
  open = false;
  start: Start = { query: "", tab: "chats" };
  constructor() {
    makeObservable(this, { open: observable, show: action, hide: action });
  }
  show(query?: string) {
    closeMenu();
    catchKeys(); // what is typed before the box draws (catcher.tsx)
    this.start = query === undefined ? { query: "", tab: "chats" } : { query, tab: "" };
    this.open = true;
  }
  hide() {
    this.open = false;
  }
}
export const search = new Search();
export const openSearch = (query?: string) => search.show(query);
export const closeSearch = () => search.hide();

// Where a hit opens: a chat in its issue's place, or its own; a milestone on its project's Issues, at its group.
function openHit(h: Hit) {
  closeSearch();
  if (h.kind === "chat") openSession(h.session!, h.issue?.slug);
  else if (h.kind === "issue") go(`/issue/${h.issue!.slug}`);
  else if (h.kind === "project") go(`/project/${h.project!.slug}`);
  else if (h.kind === "team") go(teamPath(h.team!.slug));
  else if (h.kind === "milestone") go(`/project/${h.project!.slug}/issues?group=milestone#${encodeURIComponent(h.milestone!.id)}`);
  else go(h.path!);
}

const stateOf = (i: Pick<IssueRow, "slug" | "state">) => issues.bySlug.get(i.slug)?.state ?? i.state;

function icon(h: Hit): ReactNode {
  switch (h.kind) {
    case "chat": return h.issue ? <StateIcon state={stateOf(h.issue)} /> : <Ring />;
    case "issue": return <StateIcon state={stateOf(h.issue!)} />;
    case "project": return <ProjectStatusIcon status={h.project!.status!} progress={h.project!.progress! / 100} />;
    case "team": return GLYPH.team;
    case "milestone": return <MilestoneIcon progress={h.milestone!.progress} current={h.milestone!.current} />;
    case "setting": return GLYPH.sliders;
  }
}

// What a row says at its right (step 1.5): where and when for a chat, an issue and a project, a team's open issues, a
// milestone's project and target, a setting's page.
function where(h: Hit): string {
  switch (h.kind) {
    case "chat": return [h.folder, h.age].filter(Boolean).join(" · ");
    case "issue": case "project": return [h.team?.title, h.date].filter(Boolean).join(" · ");
    case "team": return h.open ? `${h.open} open ${h.open === 1 ? "issue" : "issues"}` : "No open issues";
    case "milestone": return [h.project!.title, h.milestone!.target_label].filter(Boolean).join(" · ");
    case "setting": return h.section!;
  }
}

const many = (n: number) => n.toLocaleString("en-US");

const SearchView = observer(function SearchView() {
  const start = search.start;
  const [query, setQuery] = useState(start.query);
  const [chips, setChips] = useState<Filter[]>([]);
  const [tab, setTab] = useState<Kind | "">(start.tab);
  const [fields, setFields] = useState(known);
  const [answer, setAnswer] = useState<{ q: string; tab: Kind | ""; kinds: Group[] } | null>(null); // the server's latest
  const [at, setAt] = useState<string | null>(null); // the row in focus, by its key
  const [caret, setCaret] = useState(-1); // where the caret is, -1 while text is selected
  const [lit, setLit] = useState({ at: "", i: 0 }); // the menu's offer in focus, for the word it offers for
  const [shut, setShut] = useState(""); // the word whose menu Esc closed
  const el = useRef<HTMLDivElement>(null), input = useRef<HTMLInputElement>(null), asked = useRef(0), caretTo = useRef<number | null>(null);
  const menuEl = useRef<HTMLDivElement>(null), ghost = useRef<HTMLSpanElement>(null);
  const seq = issues.seq; // a change anywhere asks again, keeping the row in focus
  // The search: the chips, then what is typed, filters typed but not yet chips among it.
  const q = [...chips.map(textOf), query.trim()].filter(Boolean).join(" ");
  // A key:value whose key some kind has is a filter; any other, as a link's http:, is a word.
  const isFilter = (text: string) => { const f = filterOf(text); return !!f && !!fieldOf(fields, "", f.key); };
  const typed = query.split(/\s+/).filter(Boolean);
  const words = typed.filter((t) => !isFilter(t)).join(" "), filtered = chips.length > 0 || typed.some(isFilter);

  useEffect(() => {
    fetch("/api/page/search/fields").then((res) => res.json()).then((f: Fields) => { known = f; setFields(f); });
  }, []);

  useEffect(() => { void catalog.load(); }, []);

  useEffect(() => {
    const mine = ++asked.current;
    fetch(`/api/page/search?${new URLSearchParams({ q, kind: tab })}`)
      .then((res) => res.json()).then(({ kinds }: { kinds: Group[] }) => {
        if (mine === asked.current) setAnswer({ q, tab, kinds });
      });
  }, [q, tab, seq]);

  // Chats, in Chats and All with no filter, since the browser holds no chat's fields: its titles found here, then what
  // the server found that they lack, once it answers this search. All holds the best 5 of a kind with words, as the server does.
  const answered = answer?.q === q && answer.tab === tab;
  const local = !filtered && (tab === "chats" || !tab);
  const limit = !tab && words ? BEST : 100;
  const titled = useMemo(() => (local ? findChats(catalog.rows, words, limit) : null), [local, catalog.rows, words, limit]);
  const groups = useMemo(() => {
    if (!answer && !titled) return null;
    // All lists the chats alone before anything is typed (step 1.4), and its best 5 of each kind after. The settings
    // have no fields, so a filter leaves them out (step 1.3).
    const settings = findSettings(words, filtered), listed = tab === "settings" ? settings.hits : !tab && words ? settings.hits.slice(0, BEST) : [];
    const kinds = (answer?.kinds ?? []).filter((g) => !titled || g.kind !== "chats");
    if (!titled) return [...kinds, { ...settings, hits: listed }];
    const them = answered ? answer.kinds.find((g) => g.kind === "chats") : undefined;
    const mine = new Set(titled.hits.map((h) => h.key));
    const hits: Hit[] = [...titled.hits, ...(them?.hits ?? []).filter((h) => !mine.has(h.key))].slice(0, limit);
    return [{ kind: "chats" as const, count: Math.max(them?.count ?? 0, titled.count, hits.length), hits }, ...kinds, { ...settings, hits: listed }];
  }, [titled, answer, answered, words, filtered, tab, limit]);

  const shown = (groups ?? []).filter((g) => g.hits.length);
  const rows = shown.flatMap((g) => g.hits);
  const focused = rows.find((h) => h.key === at) ?? rows[0];

  // The menu under the caret, unless Esc closed it for this word, and its offer in focus, the first for a new word.
  const offered = menuAt(query, caret, fields, tab);
  const word = offered ? `${offered.start}:${offered.typed}` : "";
  const menu = offered && word !== shut ? offered : null;
  const litAt = menu && lit.at === word ? Math.min(lit.i, menu.offers.length - 1) : 0;
  // What the offer in focus adds to the word, greyed after the caret when it ends what is typed.
  const take = menu?.offers[litAt].take ?? "";
  const rest = menu && caret === query.length && take.toLowerCase().startsWith(menu.typed.toLowerCase()) ? take.slice(menu.typed.length) : "";

  const track = () => {
    const box = input.current;
    setCaret(box && box.selectionStart === box.selectionEnd ? box.selectionStart ?? -1 : -1);
  };
  // Text a chip or an offer leaves or puts back, with the caret where it belongs.
  const retype = (text: string, to: number) => {
    setQuery(text);
    caretTo.current = to;
  };
  useLayoutEffect(() => {
    if (caretTo.current === null) return;
    input.current?.setSelectionRange(caretTo.current, caretTo.current);
    caretTo.current = null;
    track();
  }, [query, chips]);
  // The filter text holds from start to end as a chip: it leaves the text, and the caret stays where it began.
  function chipOf(text: string, start: number, end: number): boolean {
    const f = filterOf(text.slice(start, end));
    if (!f || !fieldOf(fields, "", f.key)) return false;
    setChips((now) => [...now, f]);
    retype(text.slice(0, start) + text.slice(end).trimStart(), start);
    return true;
  }
  // Space or Enter at the end of a filter turns it into a chip.
  function chipAt(): boolean {
    const box = input.current, end = box?.selectionStart ?? -1, text = box?.value ?? ""; // the box's own, ahead of a draw
    if (!box || end !== box.selectionEnd || /^\S/.test(text.slice(end))) return false;
    return chipOf(text, text.slice(0, end).search(/\S*$/), end);
  }
  // An offer taken, by Tab, Enter among values, or a click: a field's name and colon, typed for its value to follow; a
  // value, the filter made a chip.
  function takeOffer(i: number) {
    const box = input.current, o = menu?.offers[i];
    if (!box || !menu || !o) return;
    const text = box.value, end = menu.start + menu.typed.length, next = text.slice(0, menu.start) + o.take + text.slice(end);
    if (!o.value || !chipOf(next, menu.start, menu.start + o.take.length)) retype(next, menu.start + o.take.length);
    box.focus();
  }
  const light = (step: number) => menu && setLit({ at: word, i: (litAt + step + menu.offers.length) % menu.offers.length });
  // A chip back into text, at its start, to change it: Backspace right after the chips, or a click on its values.
  function unchip(i: number) {
    const text = textOf(chips[i]);
    setChips((now) => now.filter((_, j) => j !== i));
    retype(query.trim() ? `${text} ${query.trimStart()}` : text, text.length);
    input.current?.focus();
  }

  const state = useRef({ rows, focused, query, chips, chipAt, unchip, menu, litAt, takeOffer, light, shutMenu: () => {}, composing: false });
  Object.assign(state.current, { rows, focused, query, chips, chipAt, unchip, menu, litAt, takeOffer, light, shutMenu: () => setShut(word) });

  const walk = (step: number) => setTab((now) => KINDS[(KINDS.findIndex((k) => k.kind === now) + 1 + step + KINDS.length + 1) % (KINDS.length + 1) - 1]?.kind ?? "");

  useEffect(() => {
    input.current?.focus();
    const caught = takeCaught();
    if (caught) retype(caught, caught.length);
    else input.current?.select(); // an old address's words: typing starts afresh, and Enter or an arrow carries on
    function onKey(e: KeyboardEvent) {
      const s = state.current, k = keyOf(e), box = input.current;
      if (e.isComposing || s.composing) return; // the input method owns this key
      const inBox = !!box && document.activeElement === box;
      const move = (step: number) => {
        const i = s.rows.indexOf(s.focused!) + step;
        if (s.rows[i]) setAt(s.rows[i].key);
      };
      const down = k === "ArrowDown" || (e.ctrlKey && k === "n"), up = k === "ArrowUp" || (e.ctrlKey && k === "p");
      let handled = true;
      if (k === "Escape") { if (s.menu) s.shutMenu(); else closeSearch(); } // the menu first, then the box
      else if (k === " " && inBox && s.chipAt()) { /* a chip */ }
      else if (k === "Backspace" && inBox && s.chips.length && box.selectionStart === 0 && box.selectionEnd === 0) s.unchip(s.chips.length - 1);
      else if (s.menu && (down || up)) s.light(down ? 1 : -1);
      else if (down) move(1);
      else if (up) move(-1);
      // Enter takes a value; letters that start a field may be words searched for, so there it opens the hit.
      else if (k === "Enter") { if (s.menu?.offers[s.litAt].value) s.takeOffer(s.litAt); else if (!(inBox && s.chipAt()) && s.focused) openHit(s.focused); }
      else if (k === "Tab" && !e.shiftKey && s.menu) s.takeOffer(s.litAt);
      else if (k === "Tab") {
        // i then Tab goes to Issues, and the i goes: it named the kind, not a thing to find. One letter never has a menu,
        // which starts at two.
        const typed = s.query.trim().toLowerCase();
        const named = e.shiftKey || typed.length !== 1 ? undefined : typed === "a" ? "" : KINDS.find((n) => letterOf(n.name) === typed)?.kind;
        if (named !== undefined) { setTab(named); retype("", 0); }
        else walk(e.shiftKey ? -1 : 1);
      }
      else handled = false;
      if (handled) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    }
    // A click outside closes it; the menu, drawn over the page, is inside.
    const onDown = (e: MouseEvent) => {
      if (!el.current?.contains(e.target as Element) && !menuEl.current?.contains(e.target as Element)) closeSearch();
    };
    addEventListener("keydown", onKey, true);
    document.addEventListener("mousedown", onDown, true);
    return () => {
      removeEventListener("keydown", onKey, true);
      document.removeEventListener("mousedown", onDown, true);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useLayoutEffect(() => {
    el.current?.querySelector("li.on")?.scrollIntoView({ block: "nearest" });
  }, [focused?.key]);
  // A new tab starts at its top.
  useLayoutEffect(() => {
    el.current?.querySelector("ul")?.scrollTo({ top: 0 });
  }, [tab]);
  // The menu under the word typed, its rows lined up with it, and kept in the window; the completion after the caret,
  // while the text fits the bar.
  useLayoutEffect(() => {
    const box = input.current, list = menuEl.current, after = ghost.current;
    if (!box) return;
    const r = box.getBoundingClientRect();
    if (list && menu) {
      const x = r.left + widthOf(query.slice(0, menu.start), box) - box.scrollLeft - 14;
      list.style.left = `${Math.max(8, Math.min(x, innerWidth - list.offsetWidth - 8))}px`;
      list.style.top = `${r.bottom + 8}px`;
      list.querySelector(".at-row.on")?.scrollIntoView({ block: "nearest" });
    }
    if (after) {
      after.style.left = `${box.offsetLeft + widthOf(query, box)}px`;
      after.style.top = `${box.offsetTop}px`;
      after.style.visibility = box.scrollWidth > box.clientWidth ? "hidden" : "";
    }
  });

  const count = (kind: Kind) => groups?.find((g) => g.kind === kind)?.count;
  const list: ReactNode[] = [];
  for (const g of shown) {
    if (!tab) {
      const name = KINDS.find((k) => k.kind === g.kind)!.name;
      list.push(
        <li key={`h-${g.kind}`} className="heading" onMouseDown={(e) => { if (e.button === 0) setTab(g.kind); }}>
          {name}<span className="all">{g.count > g.hits.length ? `${many(g.hits.length)} of ${many(g.count)}` : many(g.count)}</span>
        </li>,
      );
    }
    for (const h of g.hits) {
      list.push(
        <li key={h.key} className={h === focused ? "on" : undefined} onMouseMove={() => { if (h !== focused) setAt(h.key); }}
          onMouseDown={(e) => { if (e.button === 0) openHit(h); }}>
          <span className="ic">{icon(h)}</span>
          <span className="t" dangerouslySetInnerHTML={{ __html: h.title }} />
          {h.snippet && <span className="m" dangerouslySetInnerHTML={{ __html: h.snippet }} />}
          <span className="w">{where(h)}</span>
        </li>,
      );
    }
  }
  if (groups && !rows.length && (answered || !local)) list.push(<li key="empty" className="empty">{filtered ? "No results with these filters" : "No results"}</li>);

  // A chip is red in a kind that has no such field, which searches it as words (step 1.3): Issues have no status.
  const kindName = KINDS.find((k) => k.kind === tab)?.name;
  const chip = (f: Filter, i: number) => {
    const foreign = !!tab && !fieldOf(fields, tab, f.key) && Object.keys(fields).length > 0;
    const said = chipWords(f, fieldsNamed(fields, tab, f.key));
    return (
      <span key={`${i}/${textOf(f)}`} className={`chip${foreign ? " foreign" : ""}`} title={foreign ? `${kindName} have no ${f.key}: searched as words` : undefined}>
        <span className="chip-part chip-prop">{f.key}</span>
        <button className="chip-part chip-op" type="button" title={f.not ? "Change to is" : "Change to is not"}
          onClick={() => setChips((now) => now.map((x, j) => (j === i ? { ...x, not: !x.not } : x)))}>{said.op}</button>
        <button className="chip-part chip-values" type="button" title="Edit as text" onClick={() => unchip(i)}>
          {said.icon}<span>{said.values}</span>
        </button>
        <button className="chip-part chip-remove" type="button" title="Remove filter" onClick={() => setChips((now) => now.filter((_, j) => j !== i))}>{CROSS}</button>
      </span>
    );
  };

  return (
    <div ref={el} className="menu command search" role="dialog" aria-label="Search" onMouseDown={(e) => { if (e.target !== input.current) e.preventDefault(); }}>
      <div className="menu-head">
        <span className="menu-icon">{GLYPH.search}</span>
        <div className="s-bar" onMouseDown={(e) => { if (e.target === e.currentTarget) input.current?.focus(); }}>
          {chips.map(chip)}
          <input ref={input} className="menu-filter" type="text" placeholder={chips.length ? "" : kindName ? `Search ${kindName.toLowerCase()}…` : "Search chats, issues, projects…"} autoComplete="off" spellCheck={false}
            value={query} onChange={(e) => { setQuery(e.target.value); setShut(""); track(); }} onSelect={track}
            onCompositionStart={() => { state.current.composing = true; }}
            onCompositionEnd={() => { state.current.composing = false; }} />
          {rest && <span ref={ghost} className="s-ghost" aria-hidden="true">{rest}</span>}
        </div>
      </div>
      <nav className="s-tabs" aria-label="Kind">
        <button type="button" className={`s-tab${tab ? "" : " here"}`} title="All  A then Tab" onClick={() => setTab("")}>All</button>
        {KINDS.map(({ kind, name }) => {
          const n = count(kind);
          return (
            <button key={kind} type="button" className={`s-tab${tab === kind ? " here" : ""}${n === 0 ? " none" : ""}`} title={`${name}  ${letterOf(name).toUpperCase()} then Tab`}
              onClick={() => setTab(kind)}>
              {name}{!!n && <span className="n">{many(n)}</span>}
            </button>
          );
        })}
      </nav>
      <ul>{list}</ul>
      <div className="menu-foot">
        <button type="button" onClick={() => { if (focused) openHit(focused); }}><kbd>↵</kbd>Open</button>
        <span className="keyhint"><kbd>Tab</kbd>Complete, or next kind</span>
      </div>
      {menu && createPortal(
        <div ref={menuEl} className="at-menu s-menu" role="listbox" aria-label={menu.heading} onMouseDown={(e) => e.preventDefault()}>
          <div className="at-heading">{menu.heading}</div>
          {menu.offers.map((o, i) => (
            <div key={o.take} role="option" aria-selected={i === litAt} className={`at-row${o.value ? "" : " field"}${i === litAt ? " on" : ""}`}
              onMouseMove={() => { if (i !== litAt) setLit({ at: word, i }); }} onMouseDown={(e) => { if (e.button === 0) takeOffer(i); }}>
              {o.value && <span className="ic">{o.icon}</span>}
              <span className="n">{o.name}</span>
              {o.label && <span className="label">{o.label}</span>}
            </div>
          ))}
        </div>,
        document.body,
      )}
    </div>
  );
});

export const SearchHost = observer(function SearchHost() {
  useEffect(() => { void catalog.load(); }, []); // so that the first / finds its chats at once
  return search.open ? createPortal(<SearchView />, document.body) : null;
});
