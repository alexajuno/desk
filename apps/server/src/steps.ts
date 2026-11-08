// An issue's steps, one row each in the steps table since 8 Nov: its title, state, note and commit, and what its session
// drew on it, its diagram and words, as the session sent them with PUT /steps/<place>. Until then they were one JSON
// text on the issue's row, drawings and all, which every tick wrote back whole and every change sent to the app: "issues.
// plan_steps" (desk issue "Cut the desk server’s memory", the user, 8 Nov: "yeah, prooceed").
//
// The issue keeps its list in memory as JSON, with no drawings (issues.ts, plan_steps): load fills it from the rows, and
// save writes back only the rows that changed. A step's place, 1.2 for the first step's second, is its address in the list.
import { sql, type Db } from "./db.ts";
import { takeParts, takePictures, type StepPart, type StepPicture } from "./render.ts";

// A step as the session sends it and the issue holds it: drawn when its row holds a drawing, base desk's own, on the first
// step with a commit: where its branch left main (api.ts, firstBase).
export type PlanStep = { title: string; state: "todo" | "running" | "done"; note?: string; commit?: string; base?: string; drawn?: boolean; kids?: PlanStep[] };

type Row = { id: number; issue: string; place: string; title: string; state: PlanStep["state"]; note: string | null; commit: string | null;
  base: string | null; drawn?: boolean };

// The list as JSON, its fields always in one order, so that the same list makes the same text, loaded or sent.
const shape = (s: PlanStep): PlanStep => ({ title: s.title, state: s.state, ...(s.note ? { note: s.note } : {}), ...(s.commit ? { commit: s.commit } : {}),
  ...(s.base ? { base: s.base } : {}), ...(s.drawn ? { drawn: true } : {}), ...(s.kids?.length ? { kids: s.kids.map(shape) } : {}) });
export const json = (list: PlanStep[]): string => JSON.stringify(list.map(shape));

const placeOrder = (a: string, b: string) => {
  const x = a.split(".").map(Number), y = b.split(".").map(Number);
  for (let n = 0; n < Math.min(x.length, y.length); n++) if (x[n] !== y[n]) return x[n] - y[n];
  return x.length - y.length;
};

// Each issue's list, as JSON, from its rows; one with no rows has none.
function lists(rows: Row[]): Map<string, string> {
  const byIssue = new Map<string, Row[]>();
  for (const r of rows) byIssue.set(r.issue, [...(byIssue.get(r.issue) ?? []), r]);
  const out = new Map<string, string>();
  for (const [issue, mine] of byIssue) {
    const top: PlanStep[] = [], at = new Map<string, PlanStep>();
    for (const r of mine.sort((a, b) => placeOrder(a.place, b.place))) {
      const step: PlanStep = { title: r.title, state: r.state, ...(r.note ? { note: r.note } : {}), ...(r.commit ? { commit: r.commit } : {}),
        ...(r.base ? { base: r.base } : {}), ...(r.drawn ? { drawn: true } : {}) };
      at.set(r.place, step);
      const parent = at.get(r.place.split(".").slice(0, -1).join("."));
      if (parent) (parent.kids ??= []).push(step);
      else top.push(step);
    }
    out.set(issue, json(top));
  }
  return out;
}

const LISTED = `select id, issue, place, title, state, note, "commit", base, body is not null as drawn from steps`;
export const listsOf = async (q: Db = sql()) => lists((await q.query<Row>(LISTED)).rows);
export const listOf = async (slug: string, q: Db = sql()) => lists((await q.query<Row>(`${LISTED} where issue = $1`, [slug])).rows).get(slug) ?? null;

// Each step of the list with its place, top to bottom.
function flat(list: PlanStep[], at = ""): (PlanStep & { place: string })[] {
  return list.flatMap((s, n) => {
    const place = at ? `${at}.${n + 1}` : `${n + 1}`;
    return [{ ...s, place }, ...flat(s.kids ?? [], place)];
  });
}

// Write the issue's list to its rows, in a write: each step keeps the row of its title, at its place first, so its
// drawing stays with it as the list moves; a row the list no longer has goes, and one that did not change is left alone.
export async function put(tx: Db, slug: string, list: string | null) {
  const want = flat(list ? (JSON.parse(list) as PlanStep[]) : []);
  const rows = (await tx.query<Row>(`select id, issue, place, title, state, note, "commit", base from steps where issue = $1 order by id`, [slug])).rows;
  const taken = new Map<(typeof want)[number], Row>(), used = new Set<number>();
  const match = (same: (s: (typeof want)[number], r: Row) => boolean) => {
    for (const s of want) {
      if (taken.has(s)) continue;
      const r = rows.find((r) => !used.has(r.id) && same(s, r));
      if (r) taken.set(s, r), used.add(r.id);
    }
  };
  match((s, r) => r.title === s.title && r.place === s.place);
  match((s, r) => r.title === s.title);
  const gone = rows.filter((r) => !used.has(r.id)).map((r) => r.id);
  if (gone.length) await tx.query("delete from steps where id = any($1)", [gone]);
  for (const s of want) {
    const r = taken.get(s), values = [s.place, s.title, s.state, s.note ?? null, s.commit ?? null, s.base ?? null];
    if (!r) await tx.query(`insert into steps (issue, place, title, state, note, "commit", base) values ($1, $2, $3, $4, $5, $6, $7)`, [slug, ...values]);
    else if ([r.place, r.title, r.state, r.note, r.commit, r.base].some((v, n) => v !== values[n]))
      await tx.query(`update steps set place = $2, title = $3, state = $4, note = $5, "commit" = $6, base = $7 where id = $1`, [r.id, ...values]);
  }
}

// A step's drawing, as its session sent it: Markdown, or null for none.
export async function drawingAt(slug: string, place: string): Promise<string | null> {
  return (await sql().query<{ body: string | null }>("select body from steps where issue = $1 and place = $2", [slug, place])).rows[0]?.body ?? null;
}
export const draw = (tx: Db, slug: string, place: string, text: string) =>
  tx.query("update steps set body = $3 where issue = $1 and place = $2", [slug, place, text.trim() || null]);

// Every drawn step's drawing, by its place, split as the page draws it: its pictures, such as Today and After, or its
// parts, each with its own text and pictures; and its decisions.
export type Drawing = { pictures?: StepPicture[]; parts?: StepPart[]; said?: string };
export async function drawings(slug: string): Promise<Map<string, Drawing>> {
  const rows = (await sql().query<{ place: string; body: string }>("select place, body from steps where issue = $1 and body is not null", [slug])).rows;
  return new Map(rows.map((r) => [r.place, split(r.body)]));
}
function split(body: string): Drawing {
  const written = takeParts(body);
  if (written) return { ...(written.parts.length ? { parts: written.parts } : {}), ...(written.said ? { said: written.said } : {}) };
  const { pictures, rest } = takePictures(body);
  return { ...(pictures.length ? { pictures } : {}), ...(rest ? { said: rest } : {}) };
}
