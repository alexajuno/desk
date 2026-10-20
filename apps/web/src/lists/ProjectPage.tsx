// A project's page, Linear's (measured on linear.app on 20 Oct, its muse and imagenhub projects): its name in the top
// bar, and under it tabs, each a page of its own address. Overview (/project/<slug>) holds the name and the description,
// both edited where they are, and its Properties as a row of chips: its status, its team, and its start and target
// dates, Linear's "Apr 21st → Target date", each opening Linear's date picker. A target date passed shows red. Issues
// (/project/<slug>/issues) holds its issues by status, with the same Filter and Display as the Issues tabs, and a
// group's + files a new issue in the project.
import { observer } from "mobx-react-lite";
import { useEffect, type ReactNode } from "react";
import { useParams } from "react-router";
import { post, reason } from "../api/http";
import { usePage } from "../api/page";
import { Go } from "../app/nav";
import { Description } from "../editor/Description";
import { Bar } from "../frame/Bar";
import { projectStatusMenu, PROJECT_STATUS_NAMES, teamPicker } from "../issues/menus";
import { Title } from "../issues/IssueView";
import { reloadPages } from "../store/ui";
import { datePicker } from "../ui/datepicker";
import { GLYPH, ProjectStatusIcon } from "../ui/icons";
import { toggled } from "../ui/menu";
import { toast } from "../ui/toast";
import { Listing, Tools, type ListData } from "./parts";
import { useList } from "./useList";

export interface ProjectRowData {
  slug: string;
  title: string;
  team: string | null;
  team_title: string | null;
  status: string;
  start: string | null;
  start_label: string;
  target: string | null;
  target_label: string;
  late: boolean; // its target date passed and it is not completed or canceled
  created: string;
  issues: number;
  progress: number; // whole percent
}

interface ProjectData {
  project: ProjectRowData & { body: string; body_html: string };
  list: ListData;
}

const TABS = [["", "Overview"], ["issues", "Issues"]];

export async function setProject(slug: string, field: string, value: string) {
  const res = await post(`/project/${slug}/set`, { field, value });
  if (!res.ok) toast(await reason(res));
  await reloadPages();
}

export function ProjectPage({ tab }: { tab: string }) {
  const { slug = "" } = useParams();
  return tab ? <ProjectIssues key={slug} slug={slug} /> : <ProjectOverview key={slug} slug={slug} />;
}

function Head({ slug, title, tab, tools }: { slug: string; title?: string; tab: string; tools?: ReactNode }) {
  useEffect(() => { if (title) document.title = `${title} › ${tab ? "Issues" : "Overview"} · desk`; }, [title, tab]);
  return (
    <>
      <Bar crumb={title && <span className="bar-title project-crumb">{GLYPH.project}{title}</span>} />
      <div className="view-bar">
        <nav className="tabs" aria-label="Views">
          {TABS.map(([t, name]) => (
            <Go key={t} className={`tab${t === tab ? " here" : ""}`} to={`/project/${slug}${t && `/${t}`}`} aria-current={t === tab ? "page" : undefined}>{name}</Go>
          ))}
        </nav>
        <span className="right">{tools}</span>
      </div>
    </>
  );
}

// The project's property chips, as its Overview and the new project panel show them: status, team, start → target.
export function ProjectChips({ p, set }: { p: Pick<ProjectRowData, "status" | "team" | "team_title" | "start" | "start_label" | "target" | "target_label" | "late" | "progress">; set: (field: string, value: string) => unknown }) {
  const open = (run: (anchor: Element) => void) => (e: React.MouseEvent<HTMLButtonElement>) => { if (!toggled(e.currentTarget)) run(e.currentTarget); };
  return (
    <>
      <button className="prop-chip" type="button" title="Change status"
        onClick={open((anchor) => projectStatusMenu(p.status, { anchor }, (st) => set("status", st)))}>
        <ProjectStatusIcon status={p.status} progress={p.progress / 100} /><span>{PROJECT_STATUS_NAMES[p.status]}</span>
      </button>
      <button className={`prop-chip${p.team ? "" : " unset"}`} type="button" title="Set team"
        onClick={open((anchor) => teamPicker(p.team, { anchor }, (slug) => set("team", slug)))}>
        {GLYPH.team}<span>{p.team_title ?? "Team"}</span>
      </button>
      <span className="date-chips">
        <button className={`prop-chip${p.start ? "" : " unset"}`} type="button" aria-label="Change project start date"
          onClick={open((anchor) => datePicker({ anchor, title: "Start date", current: p.start, set: (t) => set("start", t ?? "") }))}>
          {GLYPH.start}<span>{p.start_label || "Start date"}</span>
        </button>
        {p.start && <span className="date-arrow">→</span>}
        <button className={`prop-chip${p.target ? "" : " unset"}${p.late ? " late" : ""}`} type="button" aria-label="Change project target date"
          title={p.late ? "The target date passed" : undefined}
          onClick={open((anchor) => datePicker({ anchor, title: "Target date", current: p.target, set: (t) => set("target", t ?? "") }))}>
          {GLYPH.target}<span>{p.target_label || "Target date"}</span>
        </button>
      </span>
    </>
  );
}

const ProjectOverview = observer(function ProjectOverview({ slug }: { slug: string }) {
  const { data, error } = usePage<ProjectData>(`/api/page/project/${slug}`);
  const pr = data?.project;
  return (
    <>
      <Head slug={slug} title={pr?.title} tab="" />
      <div className="scroll">
        {error && !data && <p className="muted" style={{ padding: 24 }}>{error.replace("issue", "project")}</p>}
        {pr && (
          <div className="project-overview">
            <div className="project-icon">{GLYPH.project}</div>
            <Title title={pr.title} save={(t) => setProject(slug, "title", t)} />
            <div className="project-props">
              <h3>Properties</h3>
              <ProjectChips p={pr} set={(field, value) => setProject(slug, field, value)} />
            </div>
            <h3>Description</h3>
            <Description body={pr.body} html={pr.body_html} save={(t) => setProject(slug, "body", t)} />
          </div>
        )}
      </div>
    </>
  );
});

const ProjectIssues = observer(function ProjectIssues({ slug }: { slug: string }) {
  const { data, error } = useList<ProjectData>(`/project/${slug}/issues`, `/api/page/project/${slug}`, (d) => d.list.view);
  return (
    <>
      <Head slug={slug} title={data?.project.title} tab="issues" tools={data && <Tools view={data.list.view} />} />
      <div className="scroll">
        {error && !data && <p className="muted" style={{ padding: 24 }}>{error.replace("issue", "project")}</p>}
        {data && <Listing list={data.list} empty="No issues in this project yet. Press + on a group, or set an issue's project." />}
      </div>
    </>
  );
});
