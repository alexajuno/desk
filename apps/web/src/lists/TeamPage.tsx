// A team's own page, its settings as Linear's team General settings keep them (measured 25 Oct): a card with its name and
// its identifier, the slug in its address, each a field that saves as it loses focus; then its description, and whether
// it is archived. Its issues, its Triage and its projects are pages of their own under it (/team/<slug>/all, triage and
// projects), as Linear's team has them in the sidebar. Until 20 Oct this was a desk project's page, with its issues on a
// tab; until 25 Oct its name was edited as its title, as a project's is.
import { observer } from "mobx-react-lite";
import { useEffect } from "react";
import { useParams } from "react-router";
import { post, reason } from "../api/http";
import { usePage } from "../api/page";
import { go, Go } from "../app/nav";
import { Description } from "../editor/Description";
import { Bar } from "../frame/Bar";
import { Row, Section, Switch, TextField } from "../settings/SettingsPage";
import { reloadPages } from "../store/ui";
import { GLYPH } from "../ui/icons";
import { toast } from "../ui/toast";

interface TeamData {
  team: { slug: string; title: string; state: "active" | "archived"; body: string; body_html: string };
}

// Its sidebar's pages, as links under the name.
const PAGES: [string, string][] = [["triage", "Triage"], ["all", "Issues"], ["projects", "Projects"]];

async function setTeam(slug: string, field: string, value: string): Promise<boolean> {
  const res = await post(`/team/${slug}/set`, { field, value });
  if (!res.ok) toast(await reason(res));
  await reloadPages();
  return res.ok;
}

// A new identifier moves the team to its new address, where the route answers once the move is done; its old one still
// leads to it.
async function setIdentifier(slug: string, value: string): Promise<boolean> {
  const res = await post(`/team/${slug}/set`, { field: "slug", value });
  if (!res.ok) {
    toast(await reason(res));
    return false;
  }
  go(new URL(res.url).pathname, { replace: true });
  return true;
}

// An identifier as it is typed: lowercase, with a hyphen for a space.
const identifier = (typed: string) => typed.toLowerCase().replace(/[\s_]+/g, "-");

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
          <div className="settings">
            <h1>General</h1>
            <Section>
              <Row id="team-name" title="Name">
                <TextField id="team-name" value={pr.title} save={(t) => setTeam(pr.slug, "title", t)} />
              </Row>
              <Row id="team-identifier" title="Identifier" about={`Used in its address, /team/${pr.slug}`}>
                <TextField id="team-identifier" value={pr.slug} clean={identifier} save={(t) => setIdentifier(pr.slug, t)} />
              </Row>
            </Section>
            <Section title="Description" about="What the team is for">
              <li className="set-body">
                <Description body={pr.body} html={pr.body_html} save={(t) => setTeam(pr.slug, "body", t)} />
              </li>
            </Section>
            <Section title="Status">
              <Row id="team-archived" title="Archived" about="Out of Your teams, with its issues and projects kept">
                <Switch id="team-archived" on={pr.state === "archived"} change={(on) => setTeam(pr.slug, "state", on ? "archived" : "active")} />
              </Row>
            </Section>
          </div>
        )}
      </div>
    </>
  );
});
