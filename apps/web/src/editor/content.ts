// A description between the Markdown issue.md keeps and the editor's document. What it can hold are Markdown's blocks
// and marks, checklists and tables, as Linear's editor has them (https://linear.app/docs/editor). Each top-level block
// remembers the Markdown it came from, so saving writes back the exact text of every block nobody touched: agents
// write issue.md too, and an edit to one line must not restyle the rest. No React here, so the round-trip check
// (scripts/check-markdown.ts) runs it in Node.
import { getSchema, type AnyExtension, type JSONContent } from "@tiptap/core";
import { MarkdownManager } from "@tiptap/markdown";
import StarterKit from "@tiptap/starter-kit";
import Link from "@tiptap/extension-link";
import Image from "@tiptap/extension-image";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { TableKit } from "@tiptap/extension-table";
import { marked } from "marked";

// TipTap escapes every Markdown character in text and every <, > and &, so ~/projects comes back as \~/projects and
// a -> b as a -&gt; b. This escapes only what would read as Markdown or HTML: _ inside a word, as in listen_on, is
// never emphasis in CommonMark, ~/ is a path, and only a <, & or > that could start a tag, an entity or a quote.
export function escapeText(text: string): string {
  return text
    .replace(/[\\`*[\]]/g, "\\$&")
    .replace(/_/g, (u, i: number, s: string) => (/[\p{L}\p{N}]/u.test(s[i - 1] ?? "") && /[\p{L}\p{N}]/u.test(s[i + 1] ?? "") ? u : "\\_"))
    .replace(/~(?!\/)/g, "\\~")
    .replace(/&(?=#?\w+;)/g, "&amp;")
    .replace(/<(?=[A-Za-z/!?])/g, "&lt;")
    .replace(/^>/, "&gt;");
}

// A link whose text is its address stays a bare address, as it was typed, rather than [url](url).
const BareLink = Link.extend({
  renderMarkdown: (node, h, ctx) => {
    const href = String(node.attrs?.href ?? ""), shown = (ctx.meta as { markText?: string } | undefined)?.markText;
    if (shown !== undefined && (shown === href || `mailto:${shown}` === href) && escapeText(shown) === shown) return h.renderChildren(node);
    return node.attrs?.title ? `[${h.renderChildren(node)}](${href} "${node.attrs.title}")` : `[${h.renderChildren(node)}](${href})`;
  },
});

export const extensions: AnyExtension[] = [
  StarterKit.configure({ link: false, underline: false }), // underline has no Markdown but ++x++, which desk does not draw
  BareLink.configure({ openOnClick: false, autolink: true, HTMLAttributes: { target: null, rel: null } }),
  Image,
  TaskList,
  TaskItem.configure({ nested: true }),
  TableKit,
];

const schema = getSchema(extensions);
const md = new MarkdownManager({ extensions });
// Inside code, text goes out as it is; elsewhere through escapeText (MarkdownManager.encodeTextForMarkdown otherwise).
const codeTypes = new Set(["code", "codeBlock"]);
(md as unknown as { encodeTextForMarkdown: (text: string, node: JSONContent, parent?: JSONContent) => string }).encodeTextForMarkdown =
  (text, node, parent) => (codeTypes.has(parent?.type ?? "") || node.marks?.some((m) => codeTypes.has(m.type)) ? text : escapeText(text));

interface Block { raw: string; gap: string; keys: string[] }
export interface Parsed { doc: JSONContent; blocks: Block[]; kept: string[] }

const key = (node: JSONContent) => JSON.stringify(node);

export function parse(body: string): Parsed {
  const content: JSONContent[] = [], blocks: Block[] = [], kept: string[] = [];
  for (const t of marked.lexer(body)) {
    if (t.type === "space" || !t.raw.trim()) {
      if (blocks.length) blocks[blocks.length - 1].gap += t.raw;
      continue;
    }
    // Blank lines a tokenizer took in before its block, as TipTap's task list does, belong to the gap before it.
    const lead = /^(?:[ \t]*\n)*/.exec(t.raw)![0];
    if (blocks.length) blocks[blocks.length - 1].gap += lead;
    const raw = t.raw.slice(lead.length).trimEnd();
    const nodes = (md.parse(raw).content ?? []).map((n) => schema.nodeFromJSON(n).toJSON() as JSONContent);
    // What draws as nothing, such as a link reference definition, stays in the file, at its end.
    if (!nodes.length) { kept.push(raw); continue; }
    blocks.push({ raw, gap: t.raw.slice(lead.length + raw.length), keys: nodes.map(key) });
    content.push(...nodes);
  }
  return { doc: { type: "doc", content }, blocks, kept };
}

// Markdown for what someone pasted or typed, parsed whole.
export const fromMarkdown = (text: string) => md.parse(text);

// The document as Markdown: a block nobody touched as it was written, with the space that followed it when its
// neighbour is also untouched, and any other block as TipTap writes it. An empty paragraph, Enter pressed twice, has
// no Markdown and is left out.
export function toMarkdown(doc: JSONContent, parsed: Parsed): string {
  const nodes = (doc.content ?? []).filter((n) => !(n.type === "paragraph" && !n.content?.length));
  const keys = nodes.map(key), { blocks } = parsed;
  const pieces: { text: string; block: number }[] = [];
  for (let i = 0; i < nodes.length; ) {
    const after = pieces.length ? pieces[pieces.length - 1].block + 1 : 0;
    const fits = (b: number) => blocks[b].keys.every((k, n) => k === keys[i + n]);
    const b = after > 0 && after < blocks.length && fits(after) ? after : blocks.findIndex((_, j) => fits(j));
    if (b >= 0) {
      pieces.push({ text: blocks[b].raw, block: b });
      i += blocks[b].keys.length;
    } else {
      pieces.push({ text: md.serialize({ type: "doc", content: [nodes[i]] }).trim(), block: -1 });
      i++;
    }
  }
  let out = "";
  pieces.forEach((p, n) => {
    const prev = pieces[n - 1];
    if (prev) out += prev.block >= 0 && p.block === prev.block + 1 ? blocks[prev.block].gap : "\n\n";
    out += p.text;
  });
  return [out, ...parsed.kept].filter(Boolean).join("\n\n");
}
