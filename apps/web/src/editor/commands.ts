// How the description editor takes keys and paste, as Linear's (https://linear.app/docs/editor): / opens the blocks,
// Ctrl+K links the selection, Ctrl+Shift+7 makes a checklist and Ctrl+Shift+9 a numbered list (TipTap has them the
// other way), Ctrl+Shift+\ a code block, Ctrl+Enter ticks a checklist item, and Markdown pasted as plain text turns
// into what it says. Esc leaves the editor, so desk's own shortcuts work again.
import { Extension, type Editor, type JSONContent } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { openMenu, type MenuItem } from "../ui/menu";
import { fromMarkdown } from "./content";

interface Block { label: string; hint?: string; run: (editor: Editor) => unknown }

const BLOCKS: Block[] = [
  { label: "Heading 1", hint: "#", run: (e) => e.chain().focus().setHeading({ level: 1 }).run() },
  { label: "Heading 2", hint: "##", run: (e) => e.chain().focus().setHeading({ level: 2 }).run() },
  { label: "Heading 3", hint: "###", run: (e) => e.chain().focus().setHeading({ level: 3 }).run() },
  { label: "Bulleted list", hint: "-", run: (e) => e.chain().focus().toggleBulletList().run() },
  { label: "Numbered list", hint: "1.", run: (e) => e.chain().focus().toggleOrderedList().run() },
  { label: "Checklist", hint: "[]", run: (e) => e.chain().focus().toggleTaskList().run() },
  { label: "Quote", hint: ">", run: (e) => e.chain().focus().setBlockquote().run() },
  { label: "Code block", hint: "```", run: (e) => e.chain().focus().setCodeBlock().run() },
  { label: "Diagram", hint: "d2", run: (e) => e.chain().focus().setCodeBlock({ language: "d2" }).run() },
  { label: "Table", run: (e) => e.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run() },
  { label: "Divider", hint: "---", run: (e) => e.chain().focus().setHorizontalRule().run() },
];

// The / just typed at `at`: the menu filters on what follows, and a pick puts its block in place of the /.
function slashMenu(editor: Editor, at: number) {
  const { left, bottom } = editor.view.coordsAtPos(at);
  const items = (query: string): MenuItem[] =>
    BLOCKS.filter((b) => b.label.toLowerCase().includes(query.toLowerCase())).map((b) => ({
      label: b.label,
      hint: b.hint,
      run: () => {
        editor.chain().focus().deleteRange({ from: at, to: at + 1 }).run();
        b.run(editor);
      },
    }));
  openMenu({
    x: left, y: bottom + 4, filter: "keys", placeholder: "Turn into…", className: "slash-menu", items,
    // Nothing matched: what was typed was text after all.
    onEnter: (typed) => editor.chain().focus().insertContent(typed).run(),
    onClose: () => editor.commands.focus(),
  });
}

// Ctrl+K: the link under the caret, or a new one on the selection, typed in desk's menu.
export function linkMenu(editor: Editor) {
  const { from, empty } = editor.state.selection;
  const { left, bottom } = editor.view.coordsAtPos(from);
  const was = editor.getAttributes("link").href as string | undefined;
  openMenu({
    x: left, y: bottom + 4, filter: "input", placeholder: "Paste a link…", query: was ?? "", className: "link-menu",
    items: () => [], empty: was ? "Enter to change it, or empty it to unlink" : "Enter to link",
    onEnter: (typed) => {
      const href = typed.trim(), chain = editor.chain().focus().extendMarkRange("link");
      if (!href) chain.unsetLink().run();
      else if (empty && !was) chain.insertContent({ type: "text", text: href, marks: [{ type: "link", attrs: { href } }] }).run();
      else chain.setLink({ href }).run();
    },
    onClose: () => editor.commands.focus(),
  });
}

function toggleChecked(editor: Editor) {
  const { $from } = editor.state.selection;
  for (let d = $from.depth; d > 0; d--) {
    const node = $from.node(d);
    if (node.type.name !== "taskItem") continue;
    editor.view.dispatch(editor.state.tr.setNodeMarkup($from.before(d), undefined, { ...node.attrs, checked: !node.attrs.checked }));
    return true;
  }
  return false;
}

const URL_ONLY = /^\s*\S+:\/\/\S+\s*$/;

export const Commands = Extension.create({
  name: "deskCommands",
  priority: 1000, // ahead of the lists' own Ctrl+Shift+7 and 9

  addKeyboardShortcuts() {
    return {
      "Mod-Shift-7": () => this.editor.commands.toggleTaskList(),
      "Mod-Shift-9": () => this.editor.commands.toggleOrderedList(),
      "Mod-Shift-\\": () => this.editor.commands.toggleCodeBlock(),
      "Mod-k": () => { linkMenu(this.editor); return true; },
      "Mod-Enter": () => toggleChecked(this.editor),
    };
  },

  addProseMirrorPlugins() {
    const editor = this.editor;
    // Esc's keydown can go to the input method, which ends its composition with it; then only the keyup arrives.
    let escDown = false;
    return [
      new Plugin({
        key: new PluginKey("deskCommands"),
        props: {
          handleTextInput(view, from, _to, text) {
            const { $from } = view.state.selection;
            if (text !== "/" || $from.parent.type.spec.code) return false;
            const before = $from.parent.textBetween(Math.max(0, $from.parentOffset - 1), $from.parentOffset);
            if (before && !/\s/.test(before)) return false;
            view.dispatch(view.state.tr.insertText("/", from));
            slashMenu(editor, from);
            return true;
          },
          handleDOMEvents: {
            keydown(view, e) {
              if (e.key !== "Escape") return false;
              escDown = true;
              if (e.isComposing || view.composing) return false;
              e.preventDefault();
              view.dom.blur();
              return true;
            },
            keyup(view, e) {
              if (e.key !== "Escape") return false;
              if (!escDown) view.dom.blur();
              escDown = false;
              return false;
            },
          },
          handlePaste(view, e) {
            const data = e.clipboardData, text = data?.getData("text/plain");
            // HTML on the clipboard is rich text already, except an editor's own, such as VS Code's.
            if (!data || !text || (data.types.includes("text/html") && !data.types.includes("vscode-editor-data"))) return false;
            if (view.state.selection.$from.parent.type.spec.code || URL_ONLY.test(text)) return false;
            const content = fromMarkdown(text).content ?? [];
            const lone: JSONContent | undefined = content.length === 1 && content[0].type === "paragraph" ? content[0] : undefined;
            return editor.chain().focus().insertContent(lone ? lone.content ?? [] : content).run();
          },
        },
      }),
    ];
  },
});
