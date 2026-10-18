// A description, an issue's or a project's, editable where it is, as Linear's: no mode to enter, a click puts the caret there, Markdown
// typed or pasted turns into what it says, and a toolbar comes up over selected text. It saves on its own, a second
// after you stop typing and when you leave it, and only when the Markdown changed. A change made elsewhere, such as by
// an agent, shows once you are not typing here.
import type { Editor } from "@tiptap/core";
import { Placeholder } from "@tiptap/extensions";
import { EditorContent, useEditor, useEditorState } from "@tiptap/react";
import { BubbleMenu } from "@tiptap/react/menus";
import { useEffect, useRef, type ReactNode } from "react";
import { ui } from "../store/ui";
import { Commands, linkMenu } from "./commands";
import { extensions, parse, toMarkdown, type Parsed } from "./content";
import { Diagrams, setDrawings } from "./diagrams";
import { Folds } from "./folds";

const editorExtensions = [...extensions, Placeholder.configure({ placeholder: "Add description…" }), Folds, Diagrams, Commands];
const SAVE_AFTER = 1000; // ms after the last change

// The document needs a block to put the caret in.
const editable = (parsed: Parsed) => (parsed.doc.content?.length ? parsed.doc : { type: "doc", content: [{ type: "paragraph" }] });

// save stores the Markdown; the page keys this by what it describes, so save is the same function all along.
export function Description({ body, html, save: store }: { body: string; html: string; save: (text: string) => Promise<unknown> }) {
  const parsed = useRef<Parsed | null>(null);
  parsed.current ??= parse(body);
  const saved = useRef(body); // what the file holds, as far as this page knows
  const saving = useRef(0); // saves on their way, whose page reload may still bring an older body
  const timer = useRef(0);

  function save(editor: Editor) {
    clearTimeout(timer.current);
    timer.current = 0;
    const text = toMarkdown(editor.getJSON(), parsed.current!);
    if (text === saved.current) return;
    saved.current = text;
    saving.current++;
    store(text).finally(() => saving.current--);
  }

  const editor = useEditor({
    extensions: editorExtensions,
    content: editable(parsed.current),
    editorProps: { attributes: { class: "body description" } },
    shouldRerenderOnTransaction: false,
    onUpdate: ({ editor: e }) => {
      clearTimeout(timer.current);
      timer.current = window.setTimeout(() => save(e), SAVE_AFTER);
    },
    onFocus: () => ui.setEditing(true),
    onBlur: ({ editor: e }) => {
      ui.setEditing(false);
      save(e);
    },
  });

  useEffect(() => {
    setDrawings(body, html);
    if (editor.isFocused || saving.current || body === saved.current) return;
    parsed.current = parse(body);
    saved.current = body;
    editor.commands.setContent(editable(parsed.current), { emitUpdate: false });
  }, [editor, body, html]);

  // Leaving the page with a save still waiting.
  useEffect(() => () => {
    if (!timer.current) return;
    save(editor);
    ui.setEditing(false);
  }, [editor]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      <EditorContent editor={editor} />
      <Toolbar editor={editor} />
    </>
  );
}

// Linear's toolbar over selected text: the marks, and a link.
function Toolbar({ editor }: { editor: Editor }) {
  const on = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e.isActive("bold"), italic: e.isActive("italic"), strike: e.isActive("strike"), code: e.isActive("code"), link: e.isActive("link"),
    }),
  });
  const button = (name: keyof typeof on, label: ReactNode, title: string, run: () => unknown) => (
    <button type="button" className={on[name] ? "on" : undefined} title={title} aria-label={title.split("  ")[0]} aria-pressed={on[name]}
      onMouseDown={(e) => e.preventDefault()} onClick={run}>{label}</button>
  );
  return (
    <BubbleMenu editor={editor} className="toolbar" shouldShow={({ editor: e, from, to }) => from !== to && e.isFocused && !e.isActive("codeBlock")}>
      {button("bold", <b>B</b>, "Bold  Ctrl B", () => editor.chain().focus().toggleBold().run())}
      {button("italic", <i>I</i>, "Italic  Ctrl I", () => editor.chain().focus().toggleItalic().run())}
      {button("strike", <s>S</s>, "Strikethrough  Ctrl Shift S", () => editor.chain().focus().toggleStrike().run())}
      {button("code", <code>{"<>"}</code>, "Code  Ctrl E", () => editor.chain().focus().toggleCode().run())}
      {button("link", LINK, "Link  Ctrl K", () => linkMenu(editor))}
    </BubbleMenu>
  );
}

const LINK = (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
    <path d="M6.5 9.5a3 3 0 0 0 4.2 0l2.3-2.3a3 3 0 0 0-4.2-4.2l-.9.9" />
    <path d="M9.5 6.5a3 3 0 0 0-4.2 0L3 8.8a3 3 0 0 0 4.2 4.2l.9-.9" />
  </svg>
);
