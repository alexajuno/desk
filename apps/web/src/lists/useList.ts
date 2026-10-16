// A list page's data and view: the view in the address, else the page's last one (lastView), and once the server
// drew it, the address says the view it drew, as the old pages' keepView did.
import { useEffect } from "react";
import { useLocation } from "react-router";
import { usePage } from "../api/page";
import { go } from "../app/nav";
import { listView } from "./current";
import { addressOf, hasView, lastView, remember, type ViewData } from "./view";

export function useList<T>(path: string, api: string, viewOf: (data: T) => ViewData) {
  const { search } = useLocation();
  const stored = !hasView(search) && lastView(path);
  useEffect(() => { if (stored) go(`${path}?${stored}`, { replace: true }); }, [path, stored]);
  const page = usePage<T>(`${api}${stored ? `?${stored}` : search}`);
  const data = page.data;
  useEffect(() => {
    if (!data) return;
    const view = viewOf(data);
    listView.set(path, view);
    remember(path, view.query);
    const address = addressOf(path, view.query, view.keep);
    if (address !== location.pathname.replace(/^\/app/, "") + location.search) go(address, { replace: true });
  }, [data]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => listView.clear(), []);
  return page;
}
