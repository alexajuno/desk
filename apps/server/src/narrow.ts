// A diagram too wide for the chat's half, made narrower with no word lost, by render.ts. A label's width is what a picture's
// width is mostly made of, and d2 never breaks one by itself, so a long label goes on more lines; and a left-to-right flow
// that is still too wide goes top to bottom. Measured on the 878 pictures chats had sent on steps by 5 Nov, with no height
// cap: the middle one's words went from 12px to 14px in a half of 633px, and those under 9px from 32% to 7%, and each of six
// picked at random still read right ("it's genuinely small", the user, 5 Nov). Asking a chat to redraw is no way: it cannot
// see its picture, and a blind redraw by hand came out worse.
import { isEdge, isKeyword, KEYWORDS, parse, type Statement } from "./d2read.ts";

// A line of a label, in characters of d2's mono font, 9.6px each at its 16px.
const LINE = 18;
// A shape whose children are its columns, not shapes with labels.
const TABLES = new Set(["sql_table", "class"]);

// A label's lines broken at spaces, each as long as LINE where its words allow. Its text is as written, \n as two characters.
function broken(text: string): string {
  return text.split("\\n").map((line) => {
    const lines: string[] = [];
    let now = "";
    for (const word of line.split(" ")) {
      if (now && now.length + 1 + word.length > LINE) (lines.push(now), (now = word));
      else now = now ? `${now} ${word}` : word;
    }
    return [...lines, now].join("\\n");
  }).join("\\n");
}

// Whether a statement's label is words on the picture, rather than a style's value, a shape's name or a link.
function reads(key: string): boolean {
  if (key.startsWith("(")) return key.endsWith(".label");
  if (isEdge(key)) return true;
  const path = key.split(".");
  return path.at(-1) === "label" || (!isKeyword(key) && !path.some((p) => KEYWORDS.has(p)));
}

type Edit = { from: number; to: number; text: string };
const edited = (src: string, edits: Edit[]) =>
  edits.sort((a, b) => b.from - a.from).reduce((s, e) => s.slice(0, e.from) + e.text + s.slice(e.to), src);

function labelEdits(stmts: Statement[], edits: Edit[] = []): Edit[] {
  const table = stmts.some((s) => s.key === "shape" && TABLES.has(s.label ?? ""));
  for (const st of stmts) {
    if (table && st.key !== "label") continue;
    if (!reads(st.key)) continue;
    if (st.at && st.label && st.at.quote !== "'") {
      const text = broken(st.label);
      if (text !== st.label) edits.push({ from: st.at.from, to: st.at.to, text: `"${st.at.quote ? text : text.replace(/"/g, '\\"')}"` });
    }
    if (st.map) labelEdits(st.map, edits);
  }
  return edits;
}

// The same diagram with its long labels on more lines.
export const wrapLabels = (src: string) => edited(src, labelEdits(parse(src)));

function rightEdits(stmts: Statement[], edits: Edit[] = []): Edit[] {
  for (const st of stmts) {
    if (st.key.split(".").at(-1) === "direction" && st.label === "right" && st.at) edits.push({ from: st.at.from, to: st.at.to, text: "down" });
    if (st.map) rightEdits(st.map, edits);
  }
  return edits;
}

// The same diagram with what flows left to right flowing top to bottom.
export const turnDown = (src: string) => edited(src, rightEdits(parse(src)));
