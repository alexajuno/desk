// The description's ## and ### sections fold in the editor as render.ts's do on a drawn page: a triangle in the gutter
// left of the heading, and what follows up to the next heading as high hidden while folded. The editor's document is
// flat, so the triangles are widgets and the hidden blocks a class, both decorations. What is folded is kept with the
// other folds of the page (ui/folds.ts, localStorage.folded), by the heading's id with a "d:" before it, so a Context
// in the description and one in result.md stay apart. Each heading also gets its id, for links to #context.
import { Extension } from "@tiptap/core";
import { Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import type { Node as PMNode } from "@tiptap/pm/model";
import { deskPath } from "../app/nav";

const key = new PluginKey<Set<string>>("folds");
const TRIANGLE = '<svg height="16" viewBox="0 0 16 16" width="16"><path d="M6.75194 10.6239C6.41861 10.8183 6 10.5779 6 10.192V5.80802C6 5.42212 6.41861 5.18169 6.75194 5.37613L10.5096 7.56811C10.8404 7.76105 10.8404 8.23895 10.5096 8.43189L6.75194 10.6239Z"></path></svg>';

// Python-Markdown's toc slug, as render.ts gives a heading its id: _1, _2 for a repeat.
function slugify(text: string) {
  return text.normalize("NFKD").replace(/[^\x00-\x7f]/g, "").replace(/[^\w\s-]/g, "").trim().toLowerCase().replace(/[-\s]+/g, "-");
}
function unique(id: string, ids: Set<string>) {
  while (ids.has(id) || !id) {
    const m = /^(.*)_([0-9]+)$/.exec(id);
    id = m ? `${m[1]}_${Number(m[2]) + 1}` : `${id}_1`;
  }
  ids.add(id);
  return id;
}

const remembered = (): Record<string, string[]> => JSON.parse(localStorage.folded ?? "{}");

function remember(id: string, folded: boolean) {
  const memory = remembered(), here = deskPath(), shut = new Set(memory[here]);
  if (folded) shut.add(`d:${id}`);
  else shut.delete(`d:${id}`);
  if (shut.size) memory[here] = [...shut];
  else delete memory[here];
  localStorage.folded = JSON.stringify(memory);
}

function toggle(view: EditorView, id: string, button: HTMLElement) {
  const pos = view.state.doc.resolve(view.posAtDOM(button, 0)).before(1);
  const folded = !key.getState(view.state)!.has(id);
  remember(id, folded);
  const tr = view.state.tr.setMeta(key, id);
  // A caret left in a section that folds away goes to the end of its heading.
  const heading = view.state.doc.nodeAt(pos);
  if (folded && heading && view.state.selection.from > pos + heading.nodeSize) {
    const end = sectionEnd(view.state.doc, pos, heading.attrs.level);
    if (view.state.selection.from < end) tr.setSelection(TextSelection.create(tr.doc, pos + heading.nodeSize - 1));
  }
  view.dispatch(tr);
}

function sectionEnd(doc: PMNode, from: number, level: number) {
  let end = doc.content.size;
  doc.forEach((node, offset) => {
    if (offset > from && end === doc.content.size && node.type.name === "heading" && node.attrs.level <= level) end = offset;
  });
  return end;
}

function decorations(doc: PMNode, folded: Set<string>) {
  const decos: Decoration[] = [], ids = new Set<string>();
  let hiding = 0; // the level of the folded heading whose section this is, or 0
  doc.forEach((node, pos) => {
    const level = node.type.name === "heading" ? (node.attrs.level as number) : 0;
    if (level && hiding && level <= hiding) hiding = 0;
    if (hiding) {
      decos.push(Decoration.node(pos, pos + node.nodeSize, { class: "fold-hidden" }));
      return;
    }
    if (!level) return;
    const id = unique(slugify(node.textContent), ids);
    if (level !== 2 && level !== 3) {
      decos.push(Decoration.node(pos, pos + node.nodeSize, { id }));
      return;
    }
    const shut = folded.has(id);
    decos.push(Decoration.node(pos, pos + node.nodeSize, { id, class: shut ? "fold-head folded" : "fold-head" }));
    decos.push(Decoration.widget(pos + 1, (view) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "sec-toggle";
      button.contentEditable = "false";
      button.setAttribute("aria-expanded", String(!shut));
      button.setAttribute("aria-label", shut ? "Expand section" : "Collapse section");
      button.innerHTML = TRIANGLE;
      button.addEventListener("mousedown", (e) => e.preventDefault()); // the caret stays where it was
      button.addEventListener("click", () => toggle(view, id, button));
      return button;
    }, { side: -1, key: `fold:${id}:${shut}`, ignoreSelection: true }));
    if (shut) hiding = level;
  });
  return DecorationSet.create(doc, decos);
}

export const Folds = Extension.create({
  name: "folds",
  addProseMirrorPlugins() {
    return [
      new Plugin<Set<string>>({
        key,
        state: {
          init: () => new Set((remembered()[deskPath()] ?? []).filter((k) => k.startsWith("d:")).map((k) => k.slice(2))),
          apply(tr, folded) {
            const id = tr.getMeta(key) as string | undefined;
            if (id === undefined) return folded;
            const next = new Set(folded);
            if (!next.delete(id)) next.add(id);
            return next;
          },
        },
        props: { decorations: (state) => decorations(state.doc, key.getState(state)!) },
      }),
    ];
  },
});
