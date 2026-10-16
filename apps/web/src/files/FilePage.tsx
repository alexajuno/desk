// An issue's own Markdown or D2 file, drawn as a document (templates/file.html), with its contents beside it when it
// has headings. The top bar's Read mode switches documents to the reading rules (big text, about 66 characters a line),
// remembered in this browser; a link to a heading unfolds the sections it sits in.
import { observer } from "mobx-react-lite";
import { useEffect, useLayoutEffect, useState } from "react";
import { useParams } from "react-router";
import { usePage } from "../api/page";
import { Go } from "../app/nav";
import { Bar } from "../frame/Bar";
import { issues } from "../store/issues";
import { showFolded, unfoldTo } from "../ui/folds";

interface FileData {
  issue: { slug: string; title: string };
  name: string;
  body: string;
  toc: string;
}

function ReadToggle() {
  const [on, setOn] = useState(() => document.documentElement.classList.contains("read-mode"));
  return (
    <button className="mode-toggle" type="button" aria-pressed={on} title="Big text for reading, remembered in this browser" onClick={() => {
      const scroll = document.querySelector(".scroll")!, room = () => scroll.scrollHeight - scroll.clientHeight || 1;
      const at = scroll.scrollTop / room(), now = document.documentElement.classList.toggle("read-mode");
      if (now) localStorage.readMode = "1";
      else delete localStorage.readMode;
      setOn(now);
      scroll.scrollTop = at * room();
    }}>
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"><path d="M8 4.2C6.6 3.2 4.6 2.8 2 3v9c2.6-.2 4.6.2 6 1.2 1.4-1 3.4-1.4 6-1.2V3c-2.6-.2-4.6.2-6 1.2zM8 4.2v9" /></svg>
      Read mode</button>
  );
}

export const FilePage = observer(function FilePage() {
  const { slug = "", name = "" } = useParams();
  const { data, error } = usePage<FileData>(`/api/page/file/${slug}/${encodeURIComponent(name)}`, issues.files.get(slug) ?? 0);
  useEffect(() => { if (data) document.title = `${data.name} · ${data.issue.title} · desk`; }, [data]);
  useLayoutEffect(() => {
    if (!data) return;
    showFolded();
    if (location.hash) {
      const target = document.getElementById(decodeURIComponent(location.hash.slice(1)));
      unfoldTo(target);
      target?.scrollIntoView();
    }
  }, [data]);
  return (
    <>
      <Bar crumb={<><Go to="/backlog">Backlog</Go><span className="sep">›</span><Go to={`/issue/${slug}`}>{data?.issue.title}</Go><span className="sep">›</span><span>{name}</span></>}
        tools={<ReadToggle />} />
      <div className="scroll">
        {error && !data && <p className="muted" style={{ padding: 24 }}>{error}</p>}
        {data && (
          <>
            {data.toc.includes("<li>") && <aside className="onpage" dangerouslySetInnerHTML={{ __html: `<div class="onpage-label">On this page</div>${data.toc}` }} />}
            <div className="doc" dangerouslySetInnerHTML={{ __html: data.body }} />
          </>
        )}
      </div>
    </>
  );
});
