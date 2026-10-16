// Markdown to HTML (ported from desk/render.py), with ```d2 blocks drawn as SVG diagrams by the d2 command, and each ## and ###
// section wrapped so the page can fold it. render.py used Python-Markdown with its tables, fenced_code, sane_lists and
// toc extensions; this follows that dialect where it differs from CommonMark, as the documents desk holds use it.
import MarkdownIt, { type Token } from "markdown-it";
import { spawnSync } from "node:child_process";

const D2_BLOCK = /^```d2\n([\s\S]*?)^```/gm;
// D2's theme for each of desk's: 200 is "Dark Mauve", 0 its default light one. Both renders go on the page and desk.css
// shows the one for the theme in use.
const D2_THEMES: [string, number][] = [["dark", 200], ["light", 0]];

const escapeHtml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// Cached by the diagram's source: a page draws its diagrams again on every change.
const drawn = new Map<string, string>();
function draw(source: string): string {
  const hit = drawn.get(source);
  if (hit !== undefined) return hit;
  const renders: string[] = [];
  for (const [name, theme] of D2_THEMES) {
    const run = spawnSync("d2", ["--pad=16", `--theme=${theme}`, "-", "-"], { input: source });
    if (run.status !== 0) {
      const err = `<pre class="err">${escapeHtml(run.stderr.toString())}</pre>`;
      drawn.set(source, err);
      return err;
    }
    renders.push(`<div class="for-${name}">${run.stdout.toString()}</div>`);
  }
  const html = `<div class="d2">${renders.join("")}</div>`;
  if (drawn.size > 256) drawn.delete(drawn.keys().next().value!);
  drawn.set(source, html);
  return html;
}

// Linear's group triangle, so a section folds the way a list group does.
const TRIANGLE = "M6.75194 10.6239C6.41861 10.8183 6 10.5779 6 10.192V5.80802C6 5.42212 6.41861 5.18169 6.75194 5.37613" +
  "L10.5096 7.56811C10.8404 7.76105 10.8404 8.23895 10.5096 8.43189L6.75194 10.6239Z";
const TOGGLE = `<button aria-expanded="true" aria-label="Collapse section" class="sec-toggle" type="button"><svg height="16" viewBox="0 0 16 16" width="16"><path d="${TRIANGLE}"></path></svg></button>`;

// Python-Markdown's toc slug: Latin letters to ASCII, anything but word characters, spaces and hyphens dropped,
// lowercased, runs of spaces and hyphens made one hyphen; a repeat gets _1, _2 (markdown/extensions/toc.py).
function slugify(text: string): string {
  const ascii = text.normalize("NFKD").replace(/[^\x00-\x7f]/g, "");
  return ascii.replace(/[^\w\s-]/g, "").trim().toLowerCase().replace(/[-\s]+/g, "-");
}

function unique(id: string, ids: Set<string>): string {
  while (ids.has(id) || !id) {
    const m = /^(.*)_([0-9]+)$/.exec(id);
    id = m ? `${m[1]}_${Number(m[2]) + 1}` : `${id}_1`;
  }
  ids.add(id);
  return id;
}

// Python-Markdown starts a list only after a blank line, so "Steps:" with "- a" and "- b" under it would run together
// as one paragraph; render.py put the blank line in (ListsAfterText), outside code blocks.
const LIST_ITEM = /^ *([-*+]|\d+\.) +\S/;
const RULE = /^ *([-*_])( *\1){2,} *$/;
function listsAfterText(text: string): string {
  const out: string[] = [];
  let inList = false, fence = false;
  for (const line of text.split("\n")) {
    if (/^```/.test(line)) fence = !fence;
    const item = !fence && LIST_ITEM.test(line) && !RULE.test(line);
    const last = out[out.length - 1];
    if (item && out.length && last.trim() && !inList && !last.startsWith("    ") && !last.startsWith("\t")) out.push("");
    if (item) inList = true;
    else if (!line.trim()) inList = false;
    out.push(line);
  }
  return out.join("\n");
}

// Python-Markdown nests a list only under an item indented by 4 spaces (its tab length): an item indented by 1 to 3
// spaces is the next item of the same list, so "- a" with "  - b" under it is one flat list of two. CommonMark nests
// by the item's own text column instead, so each list item's indent is written as Python-Markdown reads it: whole
// levels of 4 spaces.
const ITEM = /^( *)([-*+]|\d+\.)( +)(?=\S)/;
// The same goes for a block after a blank line inside a list: Python-Markdown keeps it in the item only when it is
// indented by a whole level, so its indent is written in whole levels too.
function listLevels(text: string): string {
  let fence = false, blank = false;
  return text.split("\n").map((line) => {
    if (/^\s*```/.test(line)) fence = !fence;
    const indent = /^ */.exec(line)![0].length;
    const out = !fence && (ITEM.test(line) || (blank && indent % 4 && line.trim()))
      ? " ".repeat(Math.floor(indent / 4) * 4) + line.slice(indent) : line;
    blank = !line.trim();
    return out;
  }).join("\n");
}

// In a quote, a list item right under a line of text goes on that line's paragraph in Python-Markdown: render.py put a
// blank line before such an item only outside quotes. So its marker is escaped there, and shows as text.
// A list marker escaped, so the line reads as text.
const asText = (line: string) => line.replace(/^( *)([-*+]|\d+)(\.?)/, (_, sp: string, mark: string, dot: string) => (dot ? `${sp}${mark}\\.` : `${sp}\\${mark}`));

function quotedLists(text: string): string {
  // What the quote's current block began with: text, whose paragraph takes list-like lines in, or a list.
  let fence = false, block: "text" | "list" | null = null;
  return text.split("\n").map((line) => {
    if (/^\s*```/.test(line)) fence = !fence;
    const q = /^(\s*>+ ?)(.*)$/.exec(line);
    if (fence || !q || !q[2].trim()) { block = null; return line; }
    if (LIST_ITEM.test(q[2])) {
      if (block === "text") return q[1] + asText(q[2]);
      block = "list";
    } else if (!block) block = "text";
    return line;
  }).join("\n");
}

// Python-Markdown's sane lists: a list goes on with items of its own kind only. In an ordered list, a "- " line right
// under an item is more of that item's text, as is a "1. " line in a bulleted one; after a blank line it starts a list of
// its own. Each level of 4 spaces keeps its own kind.
function mixedLists(text: string): string {
  let fence = false, afterBlank = true;
  let kinds: string[] = [];
  return text.split("\n").map((line) => {
    if (/^\s*```/.test(line)) fence = !fence;
    if (fence) return line;
    if (!line.trim()) { afterBlank = true; return line; }
    const m = /^( *)([-*+]|\d+\.) +\S/.exec(line);
    const indent = /^ */.exec(line)![0].length;
    let out = line;
    if (m) {
      const level = Math.floor(m[1].length / 4), kind = /\d/.test(m[2]) ? "ol" : "ul";
      if (kinds[level] && kinds[level] !== kind && !afterBlank) out = asText(line);
      else kinds = [...kinds.slice(0, level), kind];
    } else if (afterBlank && indent < 4) kinds = []; // a block of its own: the list ended
    afterBlank = false;
    return out;
  }).join("\n");
}

// Python-Markdown reads a line that starts with # as a heading even with no space after it ("#23 and #3 are merged"),
// in a list item too; CommonMark wants the space.
function bareHeadings(text: string): string {
  let fence = false;
  return text.split("\n").map((line) => {
    if (/^\s*```/.test(line)) fence = !fence;
    return fence ? line : line.replace(/^( *(?:(?:[-*+]|\d+\.) +)?)(#{1,6})(?=[^#\s])/, "$1$2 ");
  }).join("\n");
}

// Python-Markdown puts an item's text in a paragraph only around a blank line inside the list: the item before the
// blank and the item after it (markdown/blockprocessors.py, OListProcessor.run: the previous item's text moves into a
// <p>, and the first item after the blank is parsed as a loose list). An item holding more than one block shows its
// paragraphs too. CommonMark makes the whole list loose instead; this redraws markdown-it's lists Python-Markdown's way.
function pythonLooseness(tokens: Token[], lines: string[]) {
  const blankBefore = (line: number) => line > 0 && !lines[line - 1].trim();
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type !== "bullet_list_open" && t.type !== "ordered_list_open") continue;
    // This list's own items, with where each starts and ends among the tokens.
    const items: { open: number; close: number; line: number }[] = [];
    let depth = 0;
    for (let j = i + 1; j < tokens.length; j++) {
      const u = tokens[j];
      if (u.type === "bullet_list_open" || u.type === "ordered_list_open") depth++;
      else if (u.type === "bullet_list_close" || u.type === "ordered_list_close") { if (depth === 0) break; depth--; }
      else if (depth === 0 && u.type === "list_item_open") items.push({ open: j, close: -1, line: u.map ? u.map[0] : 0 });
      else if (depth === 0 && u.type === "list_item_close") items[items.length - 1].close = j;
    }
    items.forEach((item, k) => {
      const after = items[k + 1], before = items[k - 1];
      const loose = (after && blankBefore(after.line)) || (before && blankBefore(item.line));
      // The item's own paragraphs, not those of a list nested in it.
      const own: number[] = [];
      let d = 0;
      for (let j = item.open + 1; j < item.close; j++) {
        const u = tokens[j];
        if (u.type === "bullet_list_open" || u.type === "ordered_list_open") d++;
        else if (u.type === "bullet_list_close" || u.type === "ordered_list_close") d--;
        else if (d === 0 && (u.type === "paragraph_open" || u.type === "paragraph_close")) own.push(j);
      }
      const show = loose || own.length > 2;
      for (const j of own) tokens[j].hidden = !show;
    });
  }
}

function markdown(base: string) {
  const md = new MarkdownIt({ html: true, linkify: false, typographer: false });
  md.disable(["strikethrough"]); // Python-Markdown has no ~~
  // Python-Markdown strips a code span's text of all its spaces at both ends (inlinepatterns.py, BacktickInlineProcessor).
  md.renderer.rules.code_inline = (tokens, idx) => `<code>${escapeHtml(tokens[idx].content.trim())}</code>`;
  // A relative link or image points at the folder it was written in: plan.md's [card](review-card.md) means the
  // issue's file, also when plan.md shows on the issue page rather than on its own page.
  if (base) {
    md.core.ruler.push("relative", (state) => {
      const fix = (t: Token): void => {
        for (const attr of ["href", "src"]) {
          const url = t.attrGet(attr);
          if (typeof url === "string" && url && !/^([a-z][a-z0-9+.-]*:|\/|#)/i.test(url)) t.attrSet(attr, base + url);
        }
        t.children?.forEach(fix);
      };
      state.tokens.forEach(fix);
    });
  }
  return md;
}

// Each h2 and h3, with what follows it up to the next heading as high, becomes
//   <section class="sec" data-sec="<id>"><h2 class="sec-head" id="<id>">triangle, text</h2><div class="sec-body">...</div></section>
// and an h3's section sits inside its h2's; what comes before the first heading stays as is. Every heading gets the id
// Python-Markdown's toc gave it, and the h2s and h3s make the table of contents.
interface Heading { level: number; id: string; name: string }

export function toHtmlWithToc(text: string, base = ""): [string, string] {
  const diagrams: string[] = [];
  const held = text.replace(D2_BLOCK, (_, source: string) => {
    diagrams.push(draw(source));
    return `\n\nD2DIAGRAM${diagrams.length - 1}\n\n`;
  });
  const md = markdown(base);
  const env = {};
  const source = listLevels(bareHeadings(mixedLists(quotedLists(listsAfterText(held)))));
  const tokens = md.parse(source, env);
  pythonLooseness(tokens, source.split("\n"));
  const ids = new Set<string>();
  const toc: Heading[] = [];
  const open: number[] = []; // the levels of the sections open
  let html = "";
  let run: Token[] = []; // the tokens since the last heading, rendered together so markdown-it spaces them as usual
  const flush = () => { html += md.renderer.render(run, md.options, env); run = []; };
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type === "heading_open") {
      const level = Number(t.tag.slice(1));
      const inline = tokens[i + 1];
      const inner = md.renderer.render([inline], md.options, env);
      const name = inner.replace(/<[^>]+>/g, "");
      const id = unique(slugify(decodeEntities(name)), ids);
      // A heading inside another block, such as a list item, keeps its place and gets its id; only the document's own
      // headings open sections (render.py's Sections looks at the top level only).
      if (t.level > 0) {
        t.attrSet("id", id);
        if (level === 2 || level === 3) toc.push({ level, id, name });
        run.push(t);
        continue;
      }
      flush();
      if (level === 1) while (open.length) { html += "</div></section>"; open.pop(); }
      if (level === 2 || level === 3) {
        while (open.length && open[open.length - 1] >= level) { html += "</div></section>"; open.pop(); }
        toc.push({ level, id, name });
        html += `<section class="sec" data-sec="${id}"><${t.tag} class="sec-head" id="${id}">${TOGGLE}${inner}</${t.tag}>\n<div class="sec-body">`;
        open.push(level);
      } else html += `<${t.tag} id="${id}">${inner}</${t.tag}>\n`;
      i += 2; // the inline and the heading_close
      continue;
    }
    run.push(t);
  }
  flush();
  while (open.length) { html += "</div></section>"; open.pop(); }
  diagrams.forEach((svg, n) => { html = html.replace(`<p>D2DIAGRAM${n}</p>`, () => svg); });
  return [html, tocHtml(toc)];
}

export const toHtml = (text: string, base = "") => toHtmlWithToc(text, base)[0];

function decodeEntities(text: string) {
  return text.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

// The table of contents as Python-Markdown's toc writes it: <div class="toc"><ul><li><a href="#id">name</a>, the h3s
// nested under their h2.
function tocHtml(toc: Heading[]): string {
  let out = '<div class="toc">\n';
  if (!toc.length) return out + "<ul></ul>\n</div>\n";
  const walk = (items: Heading[], at: number): number => {
    out += "<ul>\n";
    let i = at;
    while (i < items.length) {
      const h = items[i];
      out += `<li><a href="#${h.id}">${h.name}</a>`;
      i++;
      if (i < items.length && items[i].level > h.level) {
        out += "\n";
        i = walk(items, i);
      }
      out += "</li>\n";
      if (i < items.length && items[i].level < items[at].level) break;
    }
    out += "</ul>\n";
    return i;
  };
  walk(toc, 0);
  return out + "</div>\n";
}
