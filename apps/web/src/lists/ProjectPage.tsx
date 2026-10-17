// A project's page (templates/project.html): its title and description, its issues by status with the same Filter and
// Display options as the Backlog, and its status, active or archived.
import { observer } from "mobx-react-lite";
import { useEffect } from "react";
import { useParams } from "react-router";
import { post, reason } from "../api/http";
import { Go } from "../app/nav";
import { Bar } from "../frame/Bar";
import { reloadPages, ui } from "../store/ui";
import { PLUS } from "../ui/icons";
import { toast } from "../ui/toast";
import { FilterBar, Groups, Tools, type ListData } from "./parts";
import { useList } from "./useList";

interface ProjectData {
  project: { slug: string; title: string; state: "active" | "archived"; body: string; body_html: string };
  list: ListData;
}

async function setProject(slug: string, field: string, value: string) {
  const res = await post(`/project/${slug}/set`, { field, value });
  if (!res.ok) toast(await reason(res));
  await reloadPages();
}

export const ProjectPage = observer(function ProjectPage() {
  const { slug = "" } = useParams();
  const { data, error } = useList<ProjectData>(`/project/${slug}`, `/api/page/project/${slug}`, (d) => d.list.view);
  const pr = data?.project;
  useEffect(() => { if (pr) document.title = `${pr.title} · desk`; }, [pr]);
  const save = (field: string) => (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const value = new FormData(e.currentTarget).get("value");
    setProject(slug, field, String(value ?? ""));
  };
  return (
    <>
      <Bar crumb={<><Go to="/projects">Projects</Go><span className="sep">›</span><span>{pr?.title}</span></>} tools={data && <Tools view={data.list.view} />} />
      <div className="scroll">
        {error && !data && <p className="muted" style={{ padding: 24 }}>{error}</p>}
        {data && pr && (
          <div className="project-page" data-project={pr.slug} data-title={pr.title}>
            <div>
              <h1 className="title">{pr.title}</h1>
              {pr.body.trim() && <div className="body description" dangerouslySetInnerHTML={{ __html: pr.body_html }} />}
              <details className="project-edit"><summary>Edit title and description</summary>
                <form key={`t${pr.title}`} onSubmit={save("title")}><input type="text" name="value" defaultValue={pr.title} aria-label="Title" /><button>Save title</button></form>
                <form key={`b${pr.body}`} onSubmit={save("body")}><textarea name="value" rows={8} aria-label="Description" defaultValue={pr.body} /><button>Save description</button></form>
              </details>
              <div className="section-label">Issues<button className="project-add add-sub" type="button" title="New issue in this project"
                onClick={() => ui.openCreator({ project: pr.slug, projectTitle: pr.title })}>{PLUS}</button></div>
              <FilterBar list={data.list} />
              <Groups list={data.list} empty="No issues yet. A project never ends; its issues do." />
            </div>
            <aside className="props">
              <div className="label">Status</div>
              <form className="prop static" onSubmit={(e) => e.preventDefault()}>
                {pr.state === "active"
                  ? <><span>Active</span><button type="button" onClick={() => setProject(pr.slug, "state", "archived")}>Archive</button></>
                  : <><span>Archived</span><button type="button" onClick={() => setProject(pr.slug, "state", "active")}>Unarchive</button></>}
              </form>
              <div className="label">Issues</div>
              <div className="prop static"><Go to={`/issues?project=${pr.slug}`}>Open in All issues</Go></div>
            </aside>
          </div>
        )}
      </div>
    </>
  );
});
