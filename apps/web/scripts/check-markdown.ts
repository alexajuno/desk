// Runs every issue's description through the editor's Markdown, from the data folder (DESK_DATA, or
// ~/.local/share/desk): read and written back untouched, it must come out as it was; and each block written fresh, as
// after an edit, must read back as the same block. Run it with `node apps/web/scripts/check-markdown.ts`.
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { parse, toMarkdown } from "../src/editor/content.ts";

const root = `${process.env.DESK_DATA ?? `${homedir()}/.local/share/desk`}/issues`;
let bodies = 0, changed = 0, blocks = 0, drifted = 0;
for (const slug of readdirSync(root).sort()) {
  let text: string;
  try { text = readFileSync(`${root}/${slug}/issue.md`, "utf8"); } catch { continue; }
  const body = text.replace(/^---\n[\s\S]*?\n---\n/, "").trim();
  bodies++;
  const parsed = parse(body);
  if (toMarkdown(parsed.doc, parsed) !== body) { changed++; console.log(`changed untouched: ${slug}`); }
  for (const node of parsed.doc.content ?? []) {
    blocks++;
    const fresh = toMarkdown({ type: "doc", content: [node] }, { doc: {}, blocks: [], kept: [] });
    const back = parse(fresh).doc.content ?? [];
    if (JSON.stringify(back) !== JSON.stringify([node])) {
      drifted++;
      console.log(`drifted: ${slug}\n  wrote: ${fresh.slice(0, 300).replace(/\n/g, "\n         ")}`);
    }
  }
}
console.log(`${bodies} descriptions, ${changed} changed untouched; ${blocks} blocks, ${drifted} read back differently once written`);
process.exit(changed || drifted ? 1 : 0);
