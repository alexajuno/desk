// The new issue panel: Linear's create panel, measured on linear.app on 2026-10-14 (desk.js openCreator). A title, a
// description, chips that open the same status, priority, protocol, parent and project menus as the rest of desk,
// and a Create more switch beside the Create issue button. C, the sidebar's pencil and Add sub-issue open it. Enter in
// the title moves to the description, Ctrl+Enter creates, Esc closes, and what you typed waits in localStorage as a
// draft until it is created, as Linear keeps its drafts. Its keys are read on the window in the capture phase, ahead
// of the page's Esc and its shortcuts; an open menu still gets its keys first, since the panel steps aside then.
import { observer } from "mobx-react-lite";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { postJson, reason } from "../api/http";
import { go } from "../app/nav";
import { valueMenu, parentPicker, projectPicker } from "../issues/menus";
import { nameOf, type Field } from "../lib/desk";
import { keyOf } from "../lib/keys";
import { fieldIcon, GLYPH } from "../ui/icons";
import { closeMenu, menus, toggled } from "../ui/menu";
import { toast } from "../ui/toast";
import { reloadPages, ui, type CreatorPreset } from "../store/ui";

const BLANK = { title: "", body: "", state: "backlog", priority: "none", protocol: "design", parent: "", parentTitle: "", project: "", projectTitle: "" };
type Draft = typeof BLANK;

export const CreatorHost = observer(function CreatorHost() {
  const preset = ui.creator;
  return preset ? <Creator key={JSON.stringify(preset)} preset={preset} /> : null;
});

function Creator({ preset }: { preset: CreatorPreset }) {
  const [draft, setDraft] = useState<Draft>(() => ({ ...BLANK, ...JSON.parse(localStorage.newIssueDraft ?? "{}"), ...preset }));
  const [more, setMore] = useState(localStorage.createMore === "1");
  const title = useRef<HTMLTextAreaElement>(null), body = useRef<HTMLTextAreaElement>(null), form = useRef<HTMLFormElement>(null);
  const s = useRef({ box: null as HTMLTextAreaElement | null, composing: false, escDown: false, sending: false, draft });
  s.current.draft = draft;

  const fit = (box: HTMLTextAreaElement | null) => { if (box) { box.style.height = "auto"; box.style.height = `${box.scrollHeight}px`; } };
  useLayoutEffect(() => { fit(title.current); fit(body.current); });

  function close(keep = true) {
    const d = s.current.draft;
    if (keep && (d.title.trim() || d.body.trim())) localStorage.newIssueDraft = JSON.stringify(d);
    else localStorage.removeItem("newIssueDraft");
    if (menus.current) closeMenu();
    ui.closeCreator();
  }

  async function submit() {
    const d = s.current.draft, name = d.title.trim().replace(/\s+/g, " ");
    if (!name) { toast("Give the issue a title first"); title.current?.focus(); return; }
    if (s.current.sending) return;
    s.current.sending = true;
    const res = await postJson("/api/issues", {
      title: name, body: d.body, state: d.state, priority: d.priority, protocol: d.protocol, parent: d.parent || null, project: d.project || null,
    });
    s.current.sending = false;
    if (!res.ok) { toast(await reason(res)); return; }
    const made = (await res.json()) as { parent: string | null; url: string };
    if (more) {
      localStorage.removeItem("newIssueDraft");
      setDraft((now) => ({ ...now, title: "", body: "" }));
      title.current?.focus();
    } else close(false);
    toast(made.parent ? "Sub-issue created" : "Issue created", { label: "View issue", run: () => go(made.url) });
    await reloadPages();
  }

  // A chip's menu is desk's own; when it closes, the caret goes back to the box it left.
  function choose(field: Field | "parent" | "project", anchor: Element) {
    const where = { anchor, onClose: () => { if (ui.creator) (s.current.box ?? title.current)?.focus(); } };
    const set = (changes: Partial<Draft>) => setDraft((now) => ({ ...now, ...changes }));
    if (field === "project") projectPicker(draft.project, where, (slug, name) => set({ project: slug, projectTitle: name }));
    else if (field === "parent") parentPicker(draft.parent, "", where, (slug, name) => set({ parent: slug, parentTitle: name }));
    else valueMenu(field, draft[field], where, (value) => set({ [field]: value }));
  }

  // Esc's keyup closes too, for when an input method kept its keydown; Tab stays inside the panel.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const k = keyOf(e), st = s.current;
      if (e.type === "keyup") {
        if (k === "Escape" && !st.escDown && !menus.current) close();
        if (k === "Escape") st.escDown = false;
        return;
      }
      if (k === "Escape") st.escDown = true;
      if (menus.current || e.isComposing || st.composing) return;
      if (k === "Escape") close();
      else if (k === "Enter" && (e.ctrlKey || e.metaKey)) submit();
      else if (k === "Enter" && e.target === title.current) body.current?.focus();
      else if (k === "Tab") {
        const stops = [...(form.current?.querySelectorAll<HTMLElement>("textarea, button, input") ?? [])], i = stops.indexOf(document.activeElement as HTMLElement);
        stops[(i + (e.shiftKey ? -1 : 1) + stops.length) % stops.length]?.focus();
      }
      else return;
      e.preventDefault();
      e.stopImmediatePropagation();
    }
    addEventListener("keydown", onKey, true);
    addEventListener("keyup", onKey, true);
    const t = title.current;
    t?.focus();
    t?.setSelectionRange(t.value.length, t.value.length);
    return () => {
      removeEventListener("keydown", onKey, true);
      removeEventListener("keyup", onKey, true);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const unset = { priority: draft.priority === "none", parent: !draft.parent, project: !draft.project };
  const chip = (field: Field | "parent" | "project", titleText: string, content: React.ReactNode, isUnset = false) => (
    <button type="button" className={`field-chip${isUnset ? " unset" : ""}`} data-field={field} title={titleText}
      onClick={(e) => { if (!toggled(e.currentTarget)) choose(field, e.currentTarget); }}>{content}</button>
  );
  return (
    <div className="creator" onMouseDown={(e) => { if (e.target === e.currentTarget && !menus.justClosed) close(); }}>
      <form ref={form} className="create-panel" role="dialog" aria-modal="true" aria-label="New issue"
        onSubmit={(e) => { e.preventDefault(); submit(); }}
        onFocus={(e) => { if ((e.target as Element).matches("textarea")) s.current.box = e.target as unknown as HTMLTextAreaElement; }}
        onCompositionStart={() => { s.current.composing = true; }} onCompositionEnd={() => { s.current.composing = false; }}>
        <header><span>New issue</span><button type="button" className="close" title="Close  Esc" onClick={() => close()}>{GLYPH.close}</button></header>
        {/* A title is one line: a pasted line break becomes a space. */}
        <textarea ref={title} className="create-title" rows={1} placeholder="Issue title" aria-label="Issue title" value={draft.title}
          onChange={(e) => setDraft({ ...draft, title: e.target.value.replace(/\s*\n\s*/g, " ") })} />
        <textarea ref={body} className="create-body" placeholder="Add description…" aria-label="Issue description" value={draft.body}
          onChange={(e) => setDraft({ ...draft, body: e.target.value })} />
        <div className="create-fields">
          {chip("state", "Change status", <>{fieldIcon("state", draft.state)}<span>{nameOf("state", draft.state)}</span></>)}
          {chip("priority", "Change priority", <>{fieldIcon("priority", draft.priority)}<span>{unset.priority ? "Priority" : nameOf("priority", draft.priority)}</span></>, unset.priority)}
          {chip("protocol", "Change protocol: how much plan, and whether it waits for go", <>{fieldIcon("protocol", draft.protocol)}<span>{nameOf("protocol", draft.protocol)}</span></>)}
          {chip("parent", "Set parent", <>{GLYPH.parent}<span>{unset.parent ? "Parent" : draft.parentTitle || draft.parent}</span></>, unset.parent)}
          {chip("project", "Set project", <>{GLYPH.project}<span>{unset.project ? "Project" : draft.projectTitle || draft.project}</span></>, unset.project)}
        </div>
        <footer>
          <label className="switch"><input type="checkbox" role="switch" checked={more}
            onChange={(e) => { setMore(e.target.checked); if (e.target.checked) localStorage.createMore = "1"; else delete localStorage.createMore; }} />Create more</label>
          <button className="primary" title="Create issue  Ctrl Enter">Create issue</button>
        </footer>
      </form>
    </div>
  );
}
