// A project's page, Linear's (measured on linear.app on 20 Oct, its muse and imagenhub projects): its name in the top
// bar, and under it tabs, each a page of its own address. Overview (/project/<slug>) holds the name and the description,
// both edited where they are, and its Properties as a row of chips: its status, its team, and its start and target
// dates, Linear's "Apr 21st → Target date", each opening Linear's date picker. A target date passed shows red. Issues
// (/project/<slug>/issues) holds its issues by status, with the same Filter and Display as the Issues tabs, and a
// group's + files a new issue in the project. Under the description, its milestones, Linear's: in their order, which
// you drag, each with its diamond, name, description, target date and how far along it is, the current one yellow.
import { observer } from "mobx-react-lite";
import { useEffect, useRef, useState, type ReactNode } from "react";
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
import { GLYPH, MilestoneIcon, ProjectStatusIcon } from "../ui/icons";
import { openMenu, toggled } from "../ui/menu";
import { keyOf } from "../lib/keys";
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

interface MilestoneData {
  id: string;
  title: string;
  body: string;
  target: string | null;
  target_label: string;
  late: boolean;
  issues: number;
  progress: number;
  current: boolean;
}

interface ProjectData {
  project: ProjectRowData & { body: string; body_html: string };
  milestones: MilestoneData[];
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
            <Milestones slug={slug} list={data!.milestones} />
          </div>
        )}
      </div>
    </>
  );
});

async function setMilestone(slug: string, id: string, field: string, value: string) {
  const res = await post(`/project/${slug}/milestone/${id}/set`, { field, value });
  if (!res.ok) toast(await reason(res));
  await reloadPages();
}

// A name or a description typed where it shows: Enter or clicking away saves, Esc leaves it as it was.
function Inline({ value, placeholder, className, save, onDone }: { value: string; placeholder: string; className: string; save: (text: string) => unknown; onDone?: () => void }) {
  const [editing, setEditing] = useState(!value && Boolean(onDone));
  const box = useRef<HTMLInputElement>(null), composing = useRef(false);
  const finish = (keep: boolean) => {
    const text = box.current?.value.trim() ?? "";
    setEditing(false);
    if (keep && text !== value) save(text);
    onDone?.();
  };
  if (!editing) return <span className={`${className}${value ? "" : " empty"}`} onClick={() => setEditing(true)}>{value || placeholder}</span>;
  return (
    <input ref={box} autoFocus className={`${className} inline-edit`} defaultValue={value} placeholder={placeholder}
      onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}
      onBlur={() => finish(true)}
      onKeyDown={(e) => {
        if (composing.current || e.nativeEvent.isComposing) return;
        const k = keyOf(e);
        if (k === "Enter") { e.preventDefault(); finish(true); }
        else if (k === "Escape") { e.preventDefault(); e.stopPropagation(); finish(false); }
      }} />
  );
}

function Milestones({ slug, list }: { slug: string; list: MilestoneData[] }) {
  const [adding, setAdding] = useState(false);
  const dragged = useRef<string | null>(null);
  const add = async (title: string) => {
    if (!title) return;
    const res = await post(`/project/${slug}/milestones`, { title });
    if (!res.ok) toast(await reason(res));
    await reloadPages();
  };
  const more = (m: MilestoneData) => (e: React.MouseEvent<HTMLButtonElement>) => {
    if (toggled(e.currentTarget)) return;
    openMenu({ anchor: e.currentTarget, className: "actions", items: () => [
      { icon: GLYPH.target, label: "Set target date…", more: true, run: () => datePicker({ anchor: e.currentTarget, title: "Target date", current: m.target, set: (t) => setMilestone(slug, m.id, "target", t ?? "") }) },
      { icon: GLYPH.trash, label: "Delete milestone", run: async () => {
        const res = await post(`/project/${slug}/milestone/${m.id}/delete`);
        if (!res.ok) toast(await reason(res));
        await reloadPages();
      } },
    ] });
  };
  return (
    <div className="milestones">
      {list.length > 0 && <h3>Milestones</h3>}
      {list.map((m, n) => (
        <div key={m.id} className={`milestone${m.current ? " current" : ""}`} draggable
          onDragStart={(e) => { dragged.current = m.id; e.dataTransfer.effectAllowed = "move"; }}
          onDragOver={(e) => { if (dragged.current) e.preventDefault(); }}
          onDrop={(e) => {
            e.preventDefault();
            const id = dragged.current;
            dragged.current = null;
            if (id && id !== m.id) void setMilestone(slug, id, "position", String(n));
          }}>
          <span className="handle" title="Drag to reorder">⋮⋮</span>
          <MilestoneIcon progress={m.progress} current={m.current} />
          <span className="milestone-text">
            <Inline className="milestone-title" value={m.title} placeholder="Milestone name" save={(t) => t && setMilestone(slug, m.id, "title", t)} />
            <Inline className="milestone-body" value={m.body} placeholder="Add description…" save={(t) => setMilestone(slug, m.id, "body", t)} />
          </span>
          <button className={`prop-chip${m.target ? "" : " unset"}${m.late ? " late" : ""}`} type="button" title="Target date"
            onClick={(e) => { if (!toggled(e.currentTarget)) datePicker({ anchor: e.currentTarget, title: "Target date", current: m.target, set: (t) => setMilestone(slug, m.id, "target", t ?? "") }); }}>
            {GLYPH.target}<span>{m.target_label || "Target date"}</span>
          </button>
          <span className="milestone-progress" title={`${m.issues} issue${m.issues === 1 ? "" : "s"}`}>{`${m.progress}%`}</span>
          <button className="ghost small milestone-more" type="button" title="Milestone actions" onClick={more(m)}>⋯</button>
        </div>
      ))}
      {adding && (
        <div className="milestone adding">
          <span className="handle" />
          <MilestoneIcon progress={0} />
          <Inline className="milestone-title" value="" placeholder="Milestone name" save={add} onDone={() => setAdding(false)} />
        </div>
      )}
      <button className="add-milestone" type="button" onClick={() => setAdding(true)}>{GLYPH.plus}Milestone</button>
    </div>
  );
}

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
