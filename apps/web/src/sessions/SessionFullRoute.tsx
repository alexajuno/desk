// /sessions/<id>: a session's chat alone in the middle (Dock.tsx draws it), until it has an issue: then its issue's
// page, which shows the chat with its issue a ] away. A new agent chat goes there once it files its issue.
import { observer } from "mobx-react-lite";
import { useEffect } from "react";
import { useParams } from "react-router";
import { go } from "../app/nav";
import { issues } from "../store/issues";

export const SessionFullRoute = observer(function SessionFullRoute() {
  const { id = "" } = useParams();
  const slug = issues.issueOf(id);
  useEffect(() => { if (slug) go(`/issue/${slug}`, { replace: true }); }, [slug]);
  return null;
});
