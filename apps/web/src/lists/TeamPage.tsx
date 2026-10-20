// A team's page, as a Linear project's was until desk's projects became teams on 20 Oct: its name in the top bar, and
// under it two tabs, each a page of its own address. Overview (/team/<slug>) holds the name and the description, both
// edited where they are, as an issue's, and its Properties: its status, active or archived. Issues (/team/<slug>/issues)
// holds its issues by status, with the same Filter and Display as the Issues tabs, and a group's + files a new issue in
// the team.
import { observer } from "mobx-react-lite";
import { useEffect, type ReactNode } from "react";
import { useParams } from "react-router";
import { post, reason } from "../api/http";
import { usePage } from "../api/page";
import { Go } from "../app/nav";
import { Description } from "../editor/Description";
import { Bar } from "../frame/Bar";
import { Title } from "../issues/IssueView";
import { reloadPages } from "../store/ui";
import { GLYPH, StateIcon } from "../ui/icons";
import { openMenu, toggled } from "../ui/menu";
import { toast } from "../ui/toast";
import { Listing, Tools, type ListData } from "./parts";
import { useList } from "./useList";

type TeamState = "active" | "archived";
interface TeamData {
  team: { slug: string; title: string; state: TeamState; body: string; body_html: string };
  list: ListData;
}

const TABS = [["", "Overview"], ["issues", "Issues"]];
const STATUS: Record<TeamState, { label: string; icon: ReactNode }> = {
  active: { label: "Active", icon: <StateIcon state="running" /> },
  archived: { label: "Archived", icon: GLYPH.archive },
};

async function setTeam(slug: string, field: string, value: string) {
  const res = await post(`/team/${slug}/set`, { field, value });
  if (!res.ok) toast(await reason(res));
  await reloadPages();
}

function statusMenu(slug: string, current: TeamState, anchor: Element) {
  const states = Object.keys(STATUS) as TeamState[];
  openMenu({
    anchor, filter: "keys", placeholder: "Change status…",
    items: (q) => states.filter((s) => STATUS[s].label.toLowerCase().includes(q.toLowerCase())).map((s) => ({
      icon: STATUS[s].icon, label: STATUS[s].label, hint: states.indexOf(s) + 1, num: states.indexOf(s) + 1, current: s === current,
      run: () => s !== current && setTeam(slug, "state", s),
    })),
  });
}

export function TeamPage({ tab }: { tab: string }) {
  const { slug = "" } = useParams();
  return tab ? <TeamIssues key={slug} slug={slug} /> : <TeamOverview key={slug} slug={slug} />;
}

function Head({ slug, title, tab, tools }: { slug: string; title?: string; tab: string; tools?: ReactNode }) {
  useEffect(() => { if (title) document.title = `${title} › ${tab ? "Issues" : "Overview"} · desk`; }, [title, tab]);
  return (
    <>
      <Bar crumb={title && <span className="bar-title project-crumb">{GLYPH.team}{title}</span>} />
      <div className="view-bar">
        <nav className="tabs" aria-label="Views">
          {TABS.map(([t, name]) => (
            <Go key={t} className={`tab${t === tab ? " here" : ""}`} to={`/team/${slug}${t && `/${t}`}`} aria-current={t === tab ? "page" : undefined}>{name}</Go>
          ))}
        </nav>
        <span className="right">{tools}</span>
      </div>
    </>
  );
}

const TeamOverview = observer(function TeamOverview({ slug }: { slug: string }) {
  const { data, error } = usePage<TeamData>(`/api/page/team/${slug}`);
  const pr = data?.team;
  return (
    <>
      <Head slug={slug} title={pr?.title} tab="" />
      <div className="scroll">
        {error && !data && <p className="muted" style={{ padding: 24 }}>{error}</p>}
        {pr && (
          <div className="project-overview">
            <div className="project-icon">{GLYPH.team}</div>
            <Title title={pr.title} save={(t) => setTeam(slug, "title", t)} />
            <div className="project-props">
              <h3>Properties</h3>
              <button className="prop-chip" type="button" title="Change status"
                onClick={(e) => { if (!toggled(e.currentTarget)) statusMenu(slug, pr.state, e.currentTarget); }}>
                {STATUS[pr.state].icon}<span>{STATUS[pr.state].label}</span>
              </button>
            </div>
            <h3>Description</h3>
            <Description body={pr.body} html={pr.body_html} save={(t) => setTeam(slug, "body", t)} />
          </div>
        )}
      </div>
    </>
  );
});

const TeamIssues = observer(function TeamIssues({ slug }: { slug: string }) {
  const { data, error } = useList<TeamData>(`/team/${slug}/issues`, `/api/page/team/${slug}`, (d) => d.list.view);
  return (
    <>
      <Head slug={slug} title={data?.team.title} tab="issues" tools={data && <Tools view={data.list.view} />} />
      <div className="scroll">
        {error && !data && <p className="muted" style={{ padding: 24 }}>{error}</p>}
        {data && <Listing list={data.list} empty="No issues yet. A team never ends; its issues do." />}
      </div>
    </>
  );
});
