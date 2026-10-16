import { createBrowserRouter } from "react-router";
import { IssueList } from "../issues/IssueList";

export const router = createBrowserRouter([{ path: "/", element: <IssueList /> }], { basename: "/app" });
