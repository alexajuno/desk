// Compares render.ts with Python-Markdown (desk/render.py) on every document desk holds: both outputs parsed and
// written back in one canonical form (attributes sorted, whitespace between blocks dropped, runs of spaces one), so
// only differences a browser draws count. Run with python.json from the reference dump:
//   node test/render-parity.ts <python.json>
import { readFileSync } from "node:fs";
import { parseDocument } from "htmlparser2";
import type { AnyNode } from "domhandler";
import { toHtmlWithToc } from "../src/render.ts";

const BLOCK = new Set(["p", "ul", "ol", "li", "div", "section", "h1", "h2", "h3", "h4", "h5", "h6", "pre", "table", "thead", "tbody", "tr", "th", "td", "blockquote", "hr", "details", "summary"]);

function canon(nodes: AnyNode[], pre = false): string {
  let out = "";
  for (const n of nodes) {
    if (n.type === "text") {
      const t = (n as { data: string }).data;
      out += pre ? t : t.replace(/\s+/g, " ");
    } else if (n.type === "tag" || n.type === "script" || n.type === "style") {
      const el = n as unknown as { name: string; attribs: Record<string, string>; children: AnyNode[] };
      const attrs = Object.entries(el.attribs).sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => ` ${k}="${k === "style" ? v.replace(/\s+/g, "").replace(/;$/, "") : v}"`).join("");
      out += `<${el.name}${attrs}>${canon(el.children, pre || el.name === "pre")}</${el.name}>`;
    }
  }
  // Whitespace next to a block's edges draws nothing.
  return out.replace(/ ?(<\/?(?:p|ul|ol|li|div|section|h[1-6]|pre|table|thead|tbody|tr|th|td|blockquote|hr|details|summary)\b[^>]*>) ?/g, "$1");
}

const normal = (html: string) => canon(parseDocument(html, { decodeEntities: true }).children as AnyNode[]);

const docs = JSON.parse(readFileSync(process.argv[2], "utf8")) as { name: string; text: string; base: string; html: string; toc?: string }[];
let same = 0;
const diffs: string[] = [];
for (const d of docs) {
  const [html, toc] = toHtmlWithToc(d.text, d.base);
  const a = normal(d.html), b = normal(html);
  const tocSame = d.toc === undefined || normal(d.toc) === normal(toc);
  if (a === b && tocSame) { same++; continue; }
  let at = 0;
  while (at < a.length && a[at] === b[at]) at++;
  diffs.push(`${d.name}${tocSame ? "" : " (toc)"}\n  py: …${a.slice(Math.max(0, at - 80), at + 160)}\n  ts: …${b.slice(Math.max(0, at - 80), at + 160)}`);
}
console.log(diffs.slice(0, Number(process.env.SHOW ?? 6)).join("\n\n"));
console.log(`\n${same}/${docs.length} documents draw the same`);
