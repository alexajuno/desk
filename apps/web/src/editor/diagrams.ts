// A ```d2 block shows as its drawing, as on a drawn page, with its source under it while the caret is in the block,
// as Linear shows a mermaid diagram. The server draws d2 (render.ts runs the d2 command), so the drawings come from the
// page's HTML of the description: the n-th diagram there is the n-th ```d2 block of the Markdown. A diagram typed or
// changed here draws once the description saves, when the page's HTML comes back.
import { Extension } from "@tiptap/core";
import { Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import type { EditorView, NodeView } from "@tiptap/pm/view";
import type { Node as PMNode } from "@tiptap/pm/model";

const D2_BLOCK = /^```d2\n([\s\S]*?)^```/gm; // render.ts's
const sourceKey = (source: string) => source.trimEnd();

// The drawings of the page shown, by their source. One description is on screen at a time.
let drawings = new Map<string, string>();
const views = new Set<CodeView>();

export function setDrawings(markdown: string, html: string) {
  const drawn = new DOMParser().parseFromString(html, "text/html").querySelectorAll(".d2, pre.err");
  const sources = [...markdown.matchAll(D2_BLOCK)].map((m) => m[1]);
  drawings = new Map(sources.map((source, i) => [sourceKey(source), drawn[i]?.outerHTML ?? ""]));
  for (const view of views) view.draw();
}

class CodeView implements NodeView {
  dom: HTMLElement;
  contentDOM: HTMLElement;
  private drawing: HTMLElement | null = null;

  constructor(private node: PMNode, readonly view: EditorView, private getPos: () => number | undefined) {
    const pre = document.createElement("pre"), code = document.createElement("code");
    pre.append(code);
    if (node.attrs.language) code.className = `language-${node.attrs.language}`;
    this.contentDOM = code;
    this.dom = pre;
    if (node.attrs.language !== "d2") return;
    this.dom = document.createElement("div");
    this.dom.className = "d2-block";
    this.drawing = document.createElement("div");
    this.drawing.className = "d2-drawing";
    this.drawing.contentEditable = "false";
    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "d2-edit";
    edit.textContent = "Edit diagram";
    edit.addEventListener("mousedown", (e) => e.preventDefault());
    edit.addEventListener("click", () => {
      const pos = this.getPos();
      if (pos === undefined) return;
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos + 1 + this.node.content.size)));
      view.focus();
    });
    pre.className = "d2-source";
    this.dom.append(this.drawing, edit, pre);
    views.add(this);
    this.draw();
  }

  // A source not drawn yet, as while you type it, keeps the drawing it had until the new one comes.
  draw() {
    if (!this.drawing) return;
    const html = drawings.get(sourceKey(this.node.textContent));
    if (html && this.drawing.dataset.drawn !== html) {
      this.drawing.innerHTML = html;
      this.drawing.dataset.drawn = html;
    }
    this.dom.classList.toggle("undrawn", !this.drawing.dataset.drawn);
  }

  showSource(from: number, to: number) {
    const pos = this.getPos();
    this.dom.classList.toggle("editing", !!this.drawing && pos !== undefined && from > pos && to < pos + this.node.nodeSize);
  }

  update(node: PMNode) {
    if (node.type !== this.node.type || node.attrs.language !== this.node.attrs.language) return false;
    this.node = node;
    this.draw();
    return true;
  }

  // The drawing and its button are the page's, not the document's: a click on the drawing opens the viewer (Frame.tsx).
  stopEvent = (e: Event) => !!this.drawing && e.target instanceof Node && !this.contentDOM.contains(e.target) && this.dom.contains(e.target);
  ignoreMutation = (m: MutationRecord | { type: "selection"; target: Node }) => m.type !== "selection" && !this.contentDOM.contains(m.target);

  destroy() {
    views.delete(this);
  }
}

// The d2 block holding the caret shows its source. A click below an open source hides it, which moves what was clicked
// up, and ProseMirror places the caret at mouseup by where the pointer is then; so while the mouse is down, sources
// stay as they are. The class is set on the block, not by a transaction: one dispatched before ProseMirror has read
// the click's selection would put the old one back.
function showSources(view: EditorView) {
  const { from, to } = view.state.selection;
  for (const v of views) if (v.view === view) v.showSource(from, to);
}

export const Diagrams = Extension.create({
  name: "diagrams",
  addProseMirrorPlugins() {
    let pressed = false;
    return [
      new Plugin({
        key: new PluginKey("diagrams"),
        view: () => ({ update: (view) => { if (!pressed) showSources(view); } }),
        props: {
          nodeViews: { codeBlock: (node, view, getPos) => new CodeView(node, view, getPos) },
          handleDOMEvents: {
            mousedown(view) {
              pressed = true;
              const up = () => {
                removeEventListener("mouseup", up, true);
                setTimeout(() => { // after ProseMirror's own mouseup
                  pressed = false;
                  if (!view.isDestroyed) showSources(view);
                });
              };
              addEventListener("mouseup", up, true);
              return false;
            },
          },
        },
      }),
    ];
  },
});
