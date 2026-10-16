import { createBrowserRouter, type LoaderFunctionArgs, Navigate } from "react-router";
import { prime } from "../api/page";
import { Frame } from "../frame/Frame";
import { IssuePage } from "../issues/IssuePage";
import { FilePage } from "../files/FilePage";
import { InboxPage } from "../inbox/InboxPage";
import { BacklogPage } from "../lists/BacklogPage";
import { ProjectPage } from "../lists/ProjectPage";
import { ProjectsPage } from "../lists/ProjectsPage";
import { listUrl } from "../lists/useList";
import { SearchPage } from "../search/SearchPage";
import { SessionsPage } from "../sessions/SessionsPage";

// Each page's loader fetches its JSON before the router moves to it, so the page on screen stays until the next one can
// draw whole (api/page.ts, prime). The first page desk opens on draws at once, as before, and fetches its own.
let opened = false;
const first = () => !opened && (opened = true);
const search = (request: Request) => new URL(request.url).search;
const at = (url: (args: LoaderFunctionArgs) => string) => (args: LoaderFunctionArgs) => (first() ? null : prime(url(args)));

// desk's pages, at the addresses they always had.
export const router = createBrowserRouter(
  [{ element: <Frame />, children: [
    { path: "/", element: <Navigate to="/backlog" replace /> },
    { path: "/backlog", element: <BacklogPage />, loader: at(({ request }) => listUrl("/backlog", "/api/page/backlog", search(request))) },
    { path: "/projects", element: <ProjectsPage />, loader: at(() => "/api/page/projects") },
    { path: "/project/:slug", element: <ProjectPage />,
      loader: at(({ params, request }) => listUrl(`/project/${params.slug}`, `/api/page/project/${params.slug}`, search(request))) },
    { path: "/issue/:slug", element: <IssuePage />, loader: at(({ params }) => `/api/page/issue/${params.slug}`) },
    { path: "/issue/:slug/f/:name", element: <FilePage />,
      loader: at(({ params }) => `/api/page/file/${params.slug}/${encodeURIComponent(params.name ?? "")}`) },
    { path: "/inbox", element: <InboxPage />, loader: at(({ request }) => {
      const i = new URL(request.url).searchParams.get("i") ?? "";
      return `/api/page/inbox${i ? `?i=${encodeURIComponent(i)}` : ""}`;
    }) },
    { path: "/search", element: <SearchPage /> },
    { path: "/sessions", element: <SessionsPage /> },
  ] }],
);
