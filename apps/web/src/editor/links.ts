// A link in a description, as Linear's (measured on linear.app on 2026-10-19): while you are not typing in the
// description, a click opens it, in a new tab when it leads out of desk, and puts no caret there. While you are, a
// click selects the whole link and brings up the link bar over it (Description.tsx), to change its address, open it or
// remove it. Ctrl+click opens it either way. Its address shows in a tooltip (ui/tooltip.ts), from content.ts's data-tip.
import { Extension, getMarkRange } from "@tiptap/core";
import { Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import { go } from "../app/nav";
import { unfoldTo } from "../ui/folds";

// Whether the link bar is up: a click on a link while typing puts it up, and the next change of selection or text
// takes it down.
export const linkBar = new PluginKey<boolean>("linkBar");

export function openLink(href: string, newTab = false) {
  if (href.startsWith("#")) {
    const target = document.getElementById(decodeURIComponent(href.slice(1)));
    unfoldTo(target);
    target?.scrollIntoView();
    return;
  }
  const url = new URL(href, location.href);
  if (!/^https?:$/.test(url.protocol)) location.href = url.href; // mailto: and the like go to their own app
  else if (newTab || url.origin !== location.origin) window.open(url.href, "_blank", "noopener");
  else go(url.pathname + url.search + url.hash);
}

const linkAt = (view: EditorView, e: MouseEvent) => {
  const a = (e.target as Element).closest?.<HTMLAnchorElement>("a[href]");
  return a && view.dom.contains(a) ? a : null;
};

export const Links = Extension.create({
  name: "deskLinks",

  addProseMirrorPlugins() {
    let opening: HTMLAnchorElement | null = null; // the link a press began on, opened if the press ends on it
    return [
      new Plugin<boolean>({
        key: linkBar,
        state: {
          init: () => false,
          apply: (tr, up) => tr.getMeta(linkBar) ?? (tr.selectionSet || tr.docChanged ? false : up),
        },
        props: {
          handleDOMEvents: {
            mousedown(view, e) {
              const a = linkAt(view, e);
              opening = a && e.button === 0 && (e.ctrlKey || e.metaKey || !view.hasFocus()) ? a : null;
              if (!opening) return false;
              e.preventDefault(); // no caret
              return true;
            },
            click(view, e) {
              const a = linkAt(view, e);
              if (!a) return false;
              e.preventDefault(); // the page's own link handling (Frame.tsx) stays out of the editor
              if (a === opening) openLink(a.getAttribute("href")!, e.ctrlKey || e.metaKey);
              opening = null;
              return true;
            },
          },
          handleClick(view, pos, e) {
            if (e.button !== 0 || !linkAt(view, e)) return false;
            const range = getMarkRange(view.state.doc.resolve(pos), view.state.schema.marks.link);
            if (!range) return false;
            view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, range.from, range.to)).setMeta(linkBar, true));
            return true;
          },
        },
      }),
    ];
  },
});
