// The search page (templates/search.html, static/search.js): results redraw as you type, best match first, with the
// first one focused. In the box, the arrows move and Enter opens; Esc leaves the box, and then J/K and the rest of the
// row keys work as on the backlog. An issue changing redraws the results, keeping the focused row and what is typed.
import { observer } from "mobx-react-lite";
import { useEffect, useRef, useState } from "react";
import { go, Go } from "../app/nav";
import { Bar } from "../frame/Bar";
import type { IssueRow } from "../lib/desk";
import { issues } from "../store/issues";
import { ui } from "../store/ui";
import { PrioIcon, StateIcon } from "../ui/icons";

interface Hit {
  issue: IssueRow;
  title: string; // HTML, the matched words marked
  snippet: string;
}

const rows = () => [...document.querySelectorAll<HTMLElement>("#results .item")];

function move(step: number) {
  const all = rows();
  if (!all.length) return;
  const i = all.findIndex((r) => r.dataset.slug === ui.focused);
  const next = all[Math.max(0, Math.min(all.length - 1, i + step))];
  ui.focus(next.dataset.slug ?? null);
  next.scrollIntoView({ block: "nearest" });
}

export const SearchPage = observer(function SearchPage() {
  const [q, setQ] = useState(() => new URLSearchParams(location.search).get("q") ?? "");
  const [hits, setHits] = useState<Hit[] | null>(null);
  const asked = useRef(0), box = useRef<HTMLInputElement>(null);
  const seq = issues.seq;
  useEffect(() => { document.title = "Search · desk"; }, []);
  useEffect(() => {
    const mine = ++asked.current, keep = ui.focused;
    fetch(`/api/page/search?q=${encodeURIComponent(q.trim())}`).then((res) => res.json()).then((found: Hit[]) => {
      if (mine !== asked.current) return;
      setHits(found);
      ui.focus(found.some((h) => h.issue.slug === keep) ? keep : found[0]?.issue.slug ?? null);
    });
  }, [q, seq]);
  useEffect(() => {
    const el = box.current;
    el?.focus();
    el?.setSelectionRange(el.value.length, el.value.length);
  }, []);
  const words = q.trim();
  return (
    <>
      <Bar crumb={
        <form className="search-box" action="/search" role="search" onSubmit={(e) => e.preventDefault()}>
          <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path fillRule="evenodd" d="M7 2C9.76142 2 12 4.23858 12 7C12 8.11012 11.6375 9.13519 11.0254 9.96484L13.7803 12.7197L13.832 12.7764C14.0723 13.0709 14.0549 13.5057 13.7803 13.7803C13.5057 14.0549 13.0709 14.0723 12.7764 13.832L12.7197 13.7803L9.96484 11.0254C9.13519 11.6375 8.11012 12 7 12C4.23858 12 2 9.76142 2 7C2 4.23858 4.23858 2 7 2ZM7 3.5C5.067 3.5 3.5 5.067 3.5 7C3.5 8.933 5.067 10.5 7 10.5C8.933 10.5 10.5 8.933 10.5 7C10.5 5.067 8.933 3.5 7 3.5Z" /></svg>
          <input ref={box} id="search-q" type="text" name="q" value={q} placeholder="Search issues by title or description…" autoComplete="off" spellCheck={false}
            onChange={(e) => {
              setQ(e.target.value);
              const t = e.target.value.trim();
              go(t ? `/search?q=${encodeURIComponent(t)}` : "/search", { replace: true });
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown" || e.key === "ArrowUp") { move(e.key === "ArrowDown" ? 1 : -1); e.preventDefault(); }
              else if (e.key === "Enter") { if (ui.focused) go(`/issue/${ui.focused}`); e.preventDefault(); }
              else if (e.key === "Escape") e.currentTarget.blur();
            }} />
        </form>
      } />
      <div className="scroll">
        <div className="page results" id="results">
          {hits !== null && (!words ? <p className="muted" style={{ padding: "24px 16px" }}>Find any issue by a word in its title or description, done ones too.</p>
            : !hits.length ? <p className="muted" style={{ padding: "24px 16px" }}>{`No issue has “${words}” in its title or description.`}</p>
            : (
              <>
                <div className="group">Issues<span className="count">{hits.length}</span></div>
                <ul className="tree">
                  {hits.map(({ issue: i, title, snippet }) => (
                    <li key={i.slug}>
                      <Go className={`item${ui.focused === i.slug ? " focus" : ""}`} to={`/issue/${i.slug}`} data-slug={i.slug} data-state={i.state} data-priority={i.priority}
                        onMouseMove={() => { if (ui.focused !== i.slug) ui.focus(i.slug); }}>
                        <PrioIcon level={i.priority} /><StateIcon state={i.state} /><span className="title" dangerouslySetInnerHTML={{ __html: title }} />
                        {snippet ? <span className="snippet" dangerouslySetInnerHTML={{ __html: snippet }} /> : <span className="spacer" />}
                        <span className="date">{i.created_short}</span>
                      </Go>
                    </li>
                  ))}
                </ul>
              </>
            ))}
        </div>
      </div>
    </>
  );
});
