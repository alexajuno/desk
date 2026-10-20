import { createBrowserRouter, type LoaderFunctionArgs, Navigate, useLocation, useParams } from "react-router";
import { prime } from "../api/page";
import { Frame } from "../frame/Frame";
import { IssuePage } from "../issues/IssuePage";
import { FilePage } from "../files/FilePage";
import { AutomationPage } from "../lists/AutomationPage";
import { AutomationsPage } from "../lists/AutomationsPage";
import { INBOX_KEEP, InboxPage } from "../inbox/InboxPage";
import { IssuesPage, issuesApi, issuesPath, TABS } from "../lists/IssuesPage";
import { ProjectPage } from "../lists/ProjectPage";
import { ProjectsPage } from "../lists/ProjectsPage";
import { TeamPage } from "../lists/TeamPage";
import { TeamsPage } from "../lists/TeamsPage";
import { listUrl } from "../lists/useList";
import { SearchPage } from "../search/SearchPage";
import { SettingsPage } from "../settings/SettingsPage";
import { SessionFullRoute } from "../sessions/SessionFullRoute";
import { TriagePage } from "../triage/TriagePage";
import { Crashed } from "./Crashed";

// Each page's loader fetches its JSON before the router moves to it, so the page on screen stays until the next one can
// draw whole (api/page.ts, prime). The first page desk opens on draws at once, as before, and fetches its own.
let opened = false;
const first = () => !opened && (opened = true);
const search = (request: Request) => new URL(request.url).search;
const at = (url: (args: LoaderFunctionArgs) => string) => (args: LoaderFunctionArgs) => (first() ? null : prime(url(args)));

// The Backlog listed every open issue, and became All issues on 17 Oct; a link to it, in an issue's text, keeps its view.
function ToIssues() {
  return <Navigate to={`/issues${useLocation().search}`} replace />;
}

// An Issues tab: All issues at /issues, Active and Backlog under it.
const tabRoute = (tab: string) => ({
  path: tab ? `/issues/${tab}` : "/issues", element: <IssuesPage key={tab} tab={tab} />,
  loader: at(({ request }) => listUrl(tab ? `/issues/${tab}` : "/issues", tab ? `/api/page/issues/${tab}` : "/api/page/issues", search(request))),
});

// A team's Issues tabs, Triage and Projects, Linear's team pages: the same pages as desk's own, on the team alone.
function TeamIssues({ tab }: { tab: string }) {
  const { slug = "" } = useParams();
  return <IssuesPage key={`${slug} ${tab}`} tab={tab} team={slug} />;
}
function TeamTriage() {
  const { slug = "" } = useParams();
  return <TriagePage key={slug} team={slug} />;
}
function TeamProjects() {
  const { slug = "" } = useParams();
  return <ProjectsPage key={slug} team={slug} />;
}
function ToTeamIssues() {
  const { slug = "" } = useParams();
  return <Navigate to={`/team/${slug}/all${useLocation().search}`} replace />;
}

// desk's pages, at the addresses they always had.
export const router = createBrowserRouter(
  [{ element: <Frame />, errorElement: <Crashed />, children: [
    { path: "/", element: <Navigate to="/issues" replace /> },
    ...["", ...TABS].map(tabRoute),
    { path: "/backlog", element: <ToIssues /> },
    { path: "/triage", element: <TriagePage /> },
    { path: "/projects", element: <ProjectsPage />, loader: at(() => "/api/page/projects") },
    { path: "/project/:slug", element: <ProjectPage tab="" />, loader: at(({ params }) => `/api/page/project/${params.slug}`) },
    { path: "/project/:slug/activity", element: <ProjectPage tab="activity" />, loader: at(({ params }) => `/api/page/project/${params.slug}`) },
    { path: "/project/:slug/issues", element: <ProjectPage tab="issues" />,
      loader: at(({ params, request }) => listUrl(`/project/${params.slug}/issues`, `/api/page/project/${params.slug}`, search(request))) },
    { path: "/teams", element: <TeamsPage />, loader: at(() => "/api/page/teams") },
    { path: "/team/:slug", element: <TeamPage />, loader: at(({ params }) => `/api/page/team/${params.slug}`) },
    ...["", ...TABS].map((tab) => ({ path: `/team/:slug/${tab || "all"}`, element: <TeamIssues tab={tab} />,
      loader: at(({ params, request }) => listUrl(issuesPath(tab, params.slug), issuesApi(tab, params.slug), search(request))) })),
    { path: "/team/:slug/issues", element: <ToTeamIssues /> },
    { path: "/team/:slug/triage", element: <TeamTriage /> },
    { path: "/team/:slug/projects", element: <TeamProjects />, loader: at(({ params }) => `/api/page/team/${params.slug}/projects`) },
    { path: "/automations", element: <AutomationsPage />, loader: at(() => "/api/page/automations") },
    { path: "/automation/:slug", element: <AutomationPage />, loader: at(({ params }) => `/api/page/automation/${params.slug}`) },
    { path: "/issue/:slug", element: <IssuePage />, loader: at(({ params }) => `/api/page/issue/${params.slug}`) },
    { path: "/issue/:slug/f/:name", element: <FilePage />,
      loader: at(({ params }) => `/api/page/file/${params.slug}/${encodeURIComponent(params.name ?? "")}`) },
    { path: "/inbox", element: <InboxPage />, loader: at(({ request }) => listUrl("/inbox", "/api/page/inbox", search(request), INBOX_KEEP)) },
    { path: "/search", element: <SearchPage /> },
    // Sessions left the sidebar on 17 Oct: it lists what runs, and the corner's clock finds the rest.
    { path: "/sessions", element: <Navigate to="/inbox" replace /> },
    { path: "/sessions/:id", element: <SessionFullRoute /> },
    { path: "/settings", element: <Navigate to="/settings/preferences" replace /> },
    { path: "/settings/:section", element: <SettingsPage />, loader: at(() => "/api/settings") },
  ] }],
);
