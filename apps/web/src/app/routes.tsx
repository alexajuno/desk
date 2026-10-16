import { createBrowserRouter } from "react-router";
import { Frame } from "../frame/Frame";
import { IssueList } from "../issues/IssueList";
import { IssuePage } from "../issues/IssuePage";
import { BASE } from "./nav";

// desk's pages, at the paths the old pages have (under /app until the app takes them over). A page not built here
// yet is a plain link to the old one (nav.ts, ported).
export const router = createBrowserRouter(
  [{ element: <Frame />, children: [
    { path: "/", element: <IssueList /> },
    { path: "/issue/:slug", element: <IssuePage /> },
  ] }],
  { basename: BASE },
);
