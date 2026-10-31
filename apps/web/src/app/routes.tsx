import { observer } from "mobx-react-lite";
import { useEffect, type ReactNode } from "react";
import { createBrowserRouter, type LoaderFunctionArgs, Navigate, useLocation, useParams } from "react-router";
import { prime } from "../api/page";
import { Frame } from "../frame/Frame";
import { IssuePage } from "../issues/IssuePage";
import { FilePage } from "../files/FilePage";
import { AutomationPage } from "../lists/AutomationPage";
import { AutomationsPage } from "../lists/AutomationsPage";
import { InboxPage } from "../inbox/InboxPage";
import { IssuesPage, issuesApi, issuesPath, TABS } from "../lists/IssuesPage";
import { ProjectPage } from "../lists/ProjectPage";
import { ProjectsPage } from "../lists/ProjectsPage";
import { TeamPage } from "../lists/TeamPage";
import { TeamsPage } from "../lists/TeamsPage";
import { listUrl } from "../lists/useList";
import { openSearch } from "../search/SearchBox";
import { SettingsPage } from "../settings/SettingsPage";
import { SessionFullRoute } from "../sessions/SessionFullRoute";
import { issues } from "../store/issues";
import { Crashed } from "./Crashed";
import { rowsIn } from "./splash";

// Each page's loader fetches its JSON before the router moves to it, so the page on screen stays until the next one can
// draw whole (api/page.ts, prime). The first page desk opens on waits the same way, under the splash (app/splash.ts).
const search = (request: Request) => new URL(request.url).search;
const at = (url: (args: LoaderFunctionArgs) => string) => (args: LoaderFunctionArgs) => prime(url(args));
// Under the splash nothing draws until the first page can (react-router's own fallback warns when a route has none).
const Booting = () => null;

// The search page left on 31 Oct for the box over the page (step 1.7): its old address, from history or a bookmark, opens
// the box over the Inbox with its words typed.
function OldSearch() {
  const q = new URLSearchParams(useLocation().search).get("q") ?? "";
  useEffect(() => openSearch(q), [q]);
  return <Navigate to="/inbox" replace />;
}

// The Backlog listed every open issue, and became All issues on 17 Oct; a link to it, in an issue's text, keeps its view.
function ToIssues() {
  return <Navigate to={`/issues${useLocation().search}`} replace />;
}

// An Issues tab: All issues at /issues, Active and Backlog under it.
const tabRoute = (tab: string) => ({
  path: tab ? `/issues/${tab}` : "/issues", element: <IssuesPage key={tab} tab={tab} />,
  loader: at(({ request }) => listUrl(tab ? `/issues/${tab}` : "/issues", tab ? `/api/page/issues/${tab}` : "/api/page/issues", search(request))),
});

// A team's page under a slug it had before a rename (teams.ts, rename), as a link in an issue's text, goes on to its
// address now, as Linear's old identifiers lead to their team; desk sends a page loaded whole there itself (app.ts).
const Moved = observer(function Moved({ children }: { children: ReactNode }) {
  const { slug = "" } = useParams();
  const { pathname, search } = useLocation();
  const now = issues.teams.has(slug) ? null : [...issues.teams.values()].find((t) => t.aliases?.split(" ").includes(slug));
  return now ? <Navigate to={`/team/${now.slug}${pathname.slice(`/team/${slug}`.length)}${search}`} replace /> : children;
});

// A team's Issues tabs and Projects, Linear's team pages: the same pages as desk's own, on the team alone.
function TeamIssues({ tab }: { tab: string }) {
  const { slug = "" } = useParams();
  return <IssuesPage key={`${slug} ${tab}`} tab={tab} team={slug} />;
}
function TeamProjects() {
  const { slug = "" } = useParams();
  return <ProjectsPage key={slug} team={slug} />;
}
function ToTeamIssues() {
  const { slug = "" } = useParams();
  return <Navigate to={`/team/${slug}/all${useLocation().search}`} replace />;
}

// desk's pages, at the addresses they always had. The frame waits for desk's rows once, as desk opens; after that it
// has them, kept current over the sync socket.
export const router = createBrowserRouter(
  [{ element: <Frame />, errorElement: <Crashed />, HydrateFallback: Booting, loader: rowsIn, shouldRevalidate: () => false, children: [
    { path: "/", element: <Navigate to="/issues" replace /> },
    ...["", ...TABS].map(tabRoute),
    { path: "/backlog", element: <ToIssues /> },
    { path: "/projects", element: <ProjectsPage />, loader: at(() => "/api/page/projects") },
    { path: "/project/:slug", element: <ProjectPage tab="" />, loader: at(({ params }) => `/api/page/project/${params.slug}`) },
    { path: "/project/:slug/activity", element: <ProjectPage tab="activity" />, loader: at(({ params }) => `/api/page/project/${params.slug}`) },
    { path: "/project/:slug/issues", element: <ProjectPage tab="issues" />,
      loader: at(({ params, request }) => listUrl(`/project/${params.slug}/issues`, `/api/page/project/${params.slug}`, search(request))) },
    { path: "/teams", element: <TeamsPage />, loader: at(() => "/api/page/teams") },
    { path: "/team/:slug", element: <Moved><TeamPage /></Moved>, loader: at(({ params }) => `/api/page/team/${params.slug}`) },
    ...["", ...TABS].map((tab) => ({ path: `/team/:slug/${tab || "all"}`, element: <Moved><TeamIssues tab={tab} /></Moved>,
      loader: at(({ params, request }) => listUrl(issuesPath(tab, params.slug), issuesApi(tab, params.slug), search(request))) })),
    { path: "/team/:slug/issues", element: <ToTeamIssues /> },
    { path: "/team/:slug/projects", element: <Moved><TeamProjects /></Moved>, loader: at(({ params }) => `/api/page/team/${params.slug}/projects`) },
    { path: "/automations", element: <AutomationsPage />, loader: at(() => "/api/page/automations") },
    { path: "/automation/:slug", element: <AutomationPage />, loader: at(({ params }) => `/api/page/automation/${params.slug}`) },
    { path: "/issue/:slug", element: <IssuePage />, loader: at(({ params }) => `/api/page/issue/${params.slug}`) },
    { path: "/issue/:slug/f/:name", element: <FilePage />,
      loader: at(({ params }) => `/api/page/file/${params.slug}/${encodeURIComponent(params.name ?? "")}`) },
    // The Inbox fetches nothing: its rows and its open issue come over the sync socket.
    { path: "/inbox", element: <InboxPage /> },
    { path: "/search", element: <OldSearch /> },
    // Sessions left the sidebar on 17 Oct: it lists what runs, and the search finds the rest.
    { path: "/sessions", element: <Navigate to="/inbox" replace /> },
    { path: "/sessions/:id", element: <SessionFullRoute /> },
    { path: "/settings", element: <Navigate to="/settings/preferences" replace /> },
    { path: "/settings/:section", element: <SettingsPage />, loader: at(() => "/api/settings") },
  ] }],
);
