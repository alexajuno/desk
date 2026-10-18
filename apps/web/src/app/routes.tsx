import { createBrowserRouter, type LoaderFunctionArgs, Navigate, useLocation } from "react-router";
import { prime } from "../api/page";
import { Frame } from "../frame/Frame";
import { IssuePage } from "../issues/IssuePage";
import { FilePage } from "../files/FilePage";
import { InboxPage } from "../inbox/InboxPage";
import { IssuesPage, TABS } from "../lists/IssuesPage";
import { ProjectPage } from "../lists/ProjectPage";
import { ProjectsPage } from "../lists/ProjectsPage";
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

// desk's pages, at the addresses they always had.
export const router = createBrowserRouter(
  [{ element: <Frame />, errorElement: <Crashed />, children: [
    { path: "/", element: <Navigate to="/issues" replace /> },
    ...["", ...TABS].map(tabRoute),
    { path: "/backlog", element: <ToIssues /> },
    { path: "/triage", element: <TriagePage /> },
    { path: "/projects", element: <ProjectsPage />, loader: at(() => "/api/page/projects") },
    { path: "/project/:slug", element: <ProjectPage tab="" />, loader: at(({ params }) => `/api/page/project/${params.slug}`) },
    { path: "/project/:slug/issues", element: <ProjectPage tab="issues" />,
      loader: at(({ params, request }) => listUrl(`/project/${params.slug}/issues`, `/api/page/project/${params.slug}`, search(request))) },
    { path: "/issue/:slug", element: <IssuePage />, loader: at(({ params }) => `/api/page/issue/${params.slug}`) },
    { path: "/issue/:slug/f/:name", element: <FilePage />,
      loader: at(({ params }) => `/api/page/file/${params.slug}/${encodeURIComponent(params.name ?? "")}`) },
    { path: "/inbox", element: <InboxPage />, loader: at(({ request }) => {
      const i = new URL(request.url).searchParams.get("i") ?? "";
      return `/api/page/inbox${i ? `?i=${encodeURIComponent(i)}` : ""}`;
    }) },
    { path: "/search", element: <SearchPage /> },
    // Sessions left the sidebar on 17 Oct: it lists what runs, and the corner's clock finds the rest.
    { path: "/sessions", element: <Navigate to="/inbox" replace /> },
    { path: "/sessions/:id", element: <SessionFullRoute /> },
    { path: "/settings", element: <Navigate to="/settings/preferences" replace /> },
    { path: "/settings/:section", element: <SettingsPage />, loader: at(() => "/api/settings") },
  ] }],
);
