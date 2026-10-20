// A team's own page, its settings as Linear keeps them: its name and description, both edited where they are, and its
// status, active or archived. Its issues, its Triage and its projects are pages of their own under it
// (/team/<slug>/all, triage and projects), as Linear's team has them in the sidebar. Until 20 Oct this was a desk
// project's page, with its issues on a tab.
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

type TeamState = "active" | "archived";
interface TeamData {
  team: { slug: string; title: string; state: TeamState; body: string; body_html: string };
}

// Its sidebar's pages, as links under the name.
const PAGES: [string, string][] = [["triage", "Triage"], ["all", "Issues"], ["projects", "Projects"]];
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

export function TeamPage() {
  const { slug = "" } = useParams();
  return <TeamOverview key={slug} slug={slug} />;
}

function Head({ slug, title }: { slug: string; title?: string }) {
  useEffect(() => { if (title) document.title = `${title} › Settings · desk`; }, [title]);
  return (
    <>
      <Bar crumb={title && <span className="bar-title project-crumb">{GLYPH.team}{title}</span>} />
      <div className="view-bar">
        <nav className="tabs" aria-label="Pages">
          {PAGES.map(([t, name]) => <Go key={t} className="tab" to={`/team/${slug}/${t}`}>{name}</Go>)}
        </nav>
      </div>
    </>
  );
}

const TeamOverview = observer(function TeamOverview({ slug }: { slug: string }) {
  const { data, error } = usePage<TeamData>(`/api/page/team/${slug}`);
  const pr = data?.team;
  return (
    <>
      <Head slug={slug} title={pr?.title} />
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
