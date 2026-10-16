import { createBrowserRouter, Navigate } from "react-router";
import { Frame } from "../frame/Frame";
import { IssuePage } from "../issues/IssuePage";
import { FilePage } from "../files/FilePage";
import { InboxPage } from "../inbox/InboxPage";
import { BacklogPage } from "../lists/BacklogPage";
import { ProjectPage } from "../lists/ProjectPage";
import { ProjectsPage } from "../lists/ProjectsPage";
import { SearchPage } from "../search/SearchPage";
import { SessionsPage } from "../sessions/SessionsPage";

// desk's pages, at the addresses they always had.
export const router = createBrowserRouter(
  [{ element: <Frame />, children: [
    { path: "/", element: <Navigate to="/backlog" replace /> },
    { path: "/backlog", element: <BacklogPage /> },
    { path: "/projects", element: <ProjectsPage /> },
    { path: "/project/:slug", element: <ProjectPage /> },
    { path: "/issue/:slug", element: <IssuePage /> },
    { path: "/issue/:slug/f/:name", element: <FilePage /> },
    { path: "/inbox", element: <InboxPage /> },
    { path: "/search", element: <SearchPage /> },
    { path: "/sessions", element: <SessionsPage /> },
  ] }],
);
