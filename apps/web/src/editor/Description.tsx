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
import { linkBar, Links, openLink } from "./links";

const editorExtensions = [...extensions, Placeholder.configure({ placeholder: "Add description…" }), Folds, Diagrams, Commands, Links];
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
      <LinkBar editor={editor} />
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
    <BubbleMenu editor={editor} className="toolbar" shouldShow={({ editor: e, from, to }) =>
      from !== to && e.isFocused && !e.isActive("codeBlock") && !linkBar.getState(e.state)}>
      {button("bold", <b>B</b>, "Bold  Ctrl B", () => editor.chain().focus().toggleBold().run())}
      {button("italic", <i>I</i>, "Italic  Ctrl I", () => editor.chain().focus().toggleItalic().run())}
      {button("strike", <s>S</s>, "Strikethrough  Ctrl Shift S", () => editor.chain().focus().toggleStrike().run())}
      {button("code", <code>{"<>"}</code>, "Code  Ctrl E", () => editor.chain().focus().toggleCode().run())}
      {button("link", LINK, "Link  Ctrl K", () => linkMenu(editor))}
    </BubbleMenu>
  );
}

// Linear's link bar, over a link clicked while typing: its address to change (Enter, or empty to unlink), then open
// and remove.
function LinkBar({ editor }: { editor: Editor }) {
  const href = useEditorState({ editor, selector: ({ editor: e }) => (linkBar.getState(e.state) ? String(e.getAttributes("link").href ?? "") : null) });
  const caretAfter = () => editor.chain().focus().setTextSelection(editor.state.selection.to).run();
  const keep = (e: { preventDefault: () => void }) => e.preventDefault(); // a press on a button leaves the focus where it is
  return (
    <BubbleMenu editor={editor} pluginKey="linkBarMenu" className="link-bar" options={{ placement: "top", offset: 6 }}
      shouldShow={({ editor: e }) => !!linkBar.getState(e.state)}>
      {href !== null && (
        <>
          <input key={href} defaultValue={href} placeholder="Enter link URL" spellCheck={false} aria-label="Link address"
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                const to = e.currentTarget.value.trim(), chain = editor.chain().focus().extendMarkRange("link");
                (to ? chain.setLink({ href: to }) : chain.unsetLink()).run();
                caretAfter();
              } else if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                caretAfter();
              }
            }}
            // Leaving the bar for anywhere but the description takes it down.
            onBlur={(e) => { if (!e.currentTarget.parentElement!.contains(e.relatedTarget) && e.relatedTarget !== editor.view.dom) editor.view.dispatch(editor.state.tr.setMeta(linkBar, false)); }} />
          <button type="button" title="Open link" onMouseDown={keep} onClick={() => openLink(href)}>{OPEN}</button>
          <button type="button" title="Remove link" onMouseDown={keep} onClick={() => editor.chain().focus().extendMarkRange("link").unsetLink().run()}>{TRASH}</button>
        </>
      )}
    </BubbleMenu>
  );
}

const OPEN = (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M7.5 1.75H4.25a2.5 2.5 0 0 0-2.5 2.5v7.5a2.5 2.5 0 0 0 2.5 2.5h7.5a2.5 2.5 0 0 0 2.5-2.5V8.5" />
    <path d="M10 1.75h4.25V6M14.25 1.75 8 8" />
  </svg>
);

// Linear's own.
const TRASH = (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
    <path fillRule="evenodd" clipRule="evenodd" d="m2 3 1.652 9.911A2.5 2.5 0 0 0 6.118 15h3.764a2.5 2.5 0 0 0 2.466-2.089L14 3H2Zm1.77 1.5 1.361 8.164a1 1 0 0 0 .987.836h3.764a1 1 0 0 0 .987-.836l1.36-8.164H3.771Z" />
    <path d="M5.5 2.5A1.5 1.5 0 0 1 7 1h2a1.5 1.5 0 0 1 1.5 1.5v1h-5v-1Z" />
    <path d="M1 3.75A.75.75 0 0 1 1.75 3h12.5a.75.75 0 0 1 0 1.5H1.75A.75.75 0 0 1 1 3.75Z" />
  </svg>
);

const LINK = (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
    <path d="M6.5 9.5a3 3 0 0 0 4.2 0l2.3-2.3a3 3 0 0 0-4.2-4.2l-.9.9" />
    <path d="M9.5 6.5a3 3 0 0 0-4.2 0L3 8.8a3 3 0 0 0 4.2 4.2l.9-.9" />
  </svg>
);
