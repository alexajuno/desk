// The new team panel: Linear's Create project modal, measured on linear.app on 2026-10-18, as desk's projects had it
// until they became teams on 20 Oct. Its icon, a name and a description. The Teams page's New team button opens it.
// Enter in the name moves to the description, Ctrl+Enter creates and opens the new team, Esc closes, and what you
// typed waits in localStorage as a draft, as the new issue panel keeps its own.
// Its keys are read on the window in the capture phase, ahead of the page's Esc and its shortcuts.
import { observer } from "mobx-react-lite";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { postJson, reason } from "../api/http";
import { go } from "../app/nav";
import { keyOf } from "../lib/keys";
import { GLYPH } from "../ui/icons";
import { toast } from "../ui/toast";
import { ui } from "../store/ui";

const BLANK = { title: "", body: "" };
type Draft = typeof BLANK;

export const TeamCreatorHost = observer(function TeamCreatorHost() {
  return ui.teamCreator ? <TeamCreator /> : null;
});

function TeamCreator() {
  const [draft, setDraft] = useState<Draft>(() => ({ ...BLANK, ...JSON.parse(localStorage.newTeamDraft ?? "{}") }));
  const title = useRef<HTMLTextAreaElement>(null), body = useRef<HTMLTextAreaElement>(null), form = useRef<HTMLFormElement>(null);
  const s = useRef({ composing: false, escDown: false, sending: false, draft });
  s.current.draft = draft;

  useLayoutEffect(() => {
    const box = title.current;
    if (box) { box.style.height = "auto"; box.style.height = `${box.scrollHeight}px`; }
  });

  function close(keep = true) {
    const d = s.current.draft;
    if (keep && (d.title.trim() || d.body.trim())) localStorage.newTeamDraft = JSON.stringify(d);
    else localStorage.removeItem("newTeamDraft");
    ui.setTeamCreator(false);
  }

  async function submit() {
    const d = s.current.draft, name = d.title.trim().replace(/\s+/g, " ");
    if (!name) { toast("Give the team a name first"); title.current?.focus(); return; }
    if (s.current.sending) return;
    s.current.sending = true;
    const res = await postJson("/api/teams", { title: name, body: d.body });
    s.current.sending = false;
    if (!res.ok) { toast(await reason(res)); return; }
    close(false);
    go(((await res.json()) as { url: string }).url);
  }

  // Esc's keyup closes too, for when an input method kept its keydown; Tab stays inside the panel.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const k = keyOf(e), st = s.current;
      if (e.type === "keyup") {
        if (k === "Escape" && !st.escDown) close();
        if (k === "Escape") st.escDown = false;
        return;
      }
      if (k === "Escape") st.escDown = true;
      if (e.isComposing || st.composing) return;
      if (k === "Escape") close();
      else if (k === "Enter" && (e.ctrlKey || e.metaKey)) submit();
      else if (k === "Enter" && e.target === title.current) body.current?.focus();
      else if (k === "Tab") {
        const stops = [...(form.current?.querySelectorAll<HTMLElement>("textarea, button") ?? [])], i = stops.indexOf(document.activeElement as HTMLElement);
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

  return (
    <div className="creator" onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <form ref={form} className="create-panel project-panel" role="dialog" aria-modal="true" aria-label="New team"
        onSubmit={(e) => { e.preventDefault(); submit(); }}
        onCompositionStart={() => { s.current.composing = true; }} onCompositionEnd={() => { s.current.composing = false; }}>
        <header><span>New team</span><button type="button" className="close" title="Close  Esc" onClick={() => close()}>{GLYPH.close}</button></header>
        <div className="project-icon">{GLYPH.team}</div>
        {/* A name is one line: a pasted line break becomes a space. */}
        <textarea ref={title} className="create-title" rows={1} placeholder="Team name" aria-label="Team name" value={draft.title}
          onChange={(e) => setDraft({ ...draft, title: e.target.value.replace(/\s*\n\s*/g, " ") })} />
        <textarea ref={body} className="create-body" placeholder="Write what the team works on…" aria-label="Team description"
          value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })} />
        <footer>
          <button className="primary" title="Create team  Ctrl Enter">Create team</button>
        </footer>
      </form>
    </div>
  );
}
