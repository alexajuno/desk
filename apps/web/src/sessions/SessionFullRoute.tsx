// /sessions/<id>: the session as the whole page, the panel grown over it (Dock.tsx draws it).
import { useParams } from "react-router";
import { SessionFullPage } from "./Dock";

export function SessionFullRoute() {
  const { id = "" } = useParams();
  return <SessionFullPage id={id} />;
}
