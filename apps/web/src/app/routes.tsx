import { createBrowserRouter, Navigate } from "react-router";
import { Frame } from "../frame/Frame";
import { IssuePage } from "../issues/IssuePage";
import { BacklogPage } from "../lists/BacklogPage";
import { ProjectPage } from "../lists/ProjectPage";
import { ProjectsPage } from "../lists/ProjectsPage";
import { BASE } from "./nav";

// desk's pages, at the paths the old pages have (under /app until the app takes them over). A page not built here
// yet is a plain link to the old one (nav.ts, ported).
export const router = createBrowserRouter(
  [{ element: <Frame />, children: [
    { path: "/", element: <Navigate to="/backlog" replace /> },
    { path: "/backlog", element: <BacklogPage /> },
    { path: "/projects", element: <ProjectsPage /> },
    { path: "/project/:slug", element: <ProjectPage /> },
    { path: "/issue/:slug", element: <IssuePage /> },
  ] }],
  { basename: BASE },
);
