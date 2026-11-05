// A table drawn as a grid of boxes, which desk refuses from a session: d2 draws each cell as a box of its own and fills
// a grid column by column, so the roles table of "Admin permissions" came out scattered, its header "supporter" under
// "kind" ("table is broken in d2. it looks... scattered", the user, 3 Nov). A table is one shape holding a Markdown
// table, as desk's prompt and the design-doc skill say. desk reads the d2 text itself, with no run of d2: a grid of two
// or more rows and columns holding 6 or more plain boxes, with no box inside them and no arrow to or from them, a third
// of them or more one line, is a table's cells: of the 788 diagrams desk held on 3 Nov, it found 24 tables so, and
// every one in two or more rows and columns, and none else. A layout passes, its boxes saying more, holding boxes or
// joined: "Admin permissions" laid its six kinds of action out in two columns, each of three or four lines.
import { ARROW, isEdge, isKeyword, parse, type Statement } from "./d2read.ts";
import { D2_BLOCK } from "./render.ts";

const MIN_BOXES = 6;

// Every id an edge names, at any depth, as each part of its path: a box any arrow reaches is no table cell.
function joined(stmts: Statement[], into = new Set<string>()): Set<string> {
  for (const st of stmts) {
    if (isEdge(st.key))
      for (const end of st.key.split(new RegExp(ARROW, "g")))
        for (const id of end.replace(/[()]|\[[^\]]*\]/g, "").split(".")) into.add(id.trim());
    if (st.map) joined(st.map, into);
  }
  return into;
}

type Found = { boxes: number; columnsFirst: boolean };

// Each map, the diagram's own and every container's, that is a grid of a table's cells.
function cellGrids(stmts: Statement[], ends: Set<string>, found: Found[] = []): Found[] {
  const at = (key: string) => stmts.findIndex((s) => s.key === key);
  const count = (key: string) => Number(stmts[at(key)]?.label) || 0;
  const cols = count("grid-columns"), rows = count("grid-rows");
  const boxes = new Map<string, Statement[]>();
  for (const st of stmts) {
    if (!isEdge(st.key) && !isKeyword(st.key) && !st.key.includes(".")) boxes.set(st.key, [...(boxes.get(st.key) ?? []), st]);
    if (st.map) cellGrids(st.map, ends, found);
  }
  const n = boxes.size;
  const grid = cols && rows ? cols > 1 && rows > 1 : cols ? cols > 1 && n > cols : rows > 1 && n > rows;
  if (!grid) return found;
  const plain = [...boxes].filter(([id, defs]) => !ends.has(id) && defs.every((d) => (d.map ?? []).every((s) => isKeyword(s.key))));
  const oneLine = plain.filter(([, defs]) => {
    const label = defs.flatMap((d) => [d, ...(d.map ?? []).filter((s) => s.key === "label")]).findLast((s) => s.label !== undefined);
    return !label || (!label.block && !label.label!.includes("\\n"));
  }).length;
  if (plain.length >= MIN_BOXES && oneLine * 3 >= plain.length)
    found.push({ boxes: plain.length, columnsFirst: cols > 0 && (!rows || at("grid-columns") < at("grid-rows")) });
  return found;
}

// The refusal for a step or a section whose d2 draws a table as boxes, naming each such block by its line in what was
// sent, or null when none does.
export function tableOfBoxes(text: string): string | null {
  const hits: { line: number; found: Found }[] = [];
  for (const m of text.matchAll(D2_BLOCK)) {
    const stmts = parse(m[2]);
    const found = cellGrids(stmts, joined(stmts))[0];
    if (found) hits.push({ line: text.slice(0, m.index).split("\n").length, found });
  }
  if (!hits.length) return null;
  const [{ line, found }, ...more] = hits;
  const order = found.columnsFirst ? ", and d2 fills a grid column by column, so its cells land out of place" : "";
  const lines = more.map((h) => h.line);
  const also = lines.length > 1 ? ` So do the ones at lines ${lines.slice(0, -1).join(", ")} and ${lines.at(-1)}.`
    : lines.length ? ` So does the one at line ${lines[0]}.` : "";
  return `The d2 block at line ${line} draws a table as a grid of ${found.boxes} separate boxes: each cell comes out a box ` +
    `of its own${order}.${also} Draw a table as one shape holding a Markdown table: t: |||md, a header line, a |---| ` +
    "line and one line per row, then |||, the cell that changes in **bold** (pattern 7 of the design-doc skill's d2 " +
    "reference). A grid is only for laying out separate things.";
}
