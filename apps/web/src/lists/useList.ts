// A list page's data and view: the view in the address, else the page's last one (lastView), and once the server
// drew it, the address says the view it drew, as the old pages' keepView did.
import { useEffect } from "react";
import { useLocation } from "react-router";
import { usePage } from "../api/page";
import { go } from "../app/nav";
import { listView } from "./current";
import { addressOf, hasView, lastView, remember, type ViewData } from "./view";

// The view a list page draws: the one in the address, else the page's last one.
const storedView = (path: string, search: string) => !hasView(search) && lastView(path);

// The address of a list page's JSON, which its route's loader fetches first (api/page.ts, prime).
export const listUrl = (path: string, api: string, search: string) => {
  const stored = storedView(path, search);
  return `${api}${stored ? `?${stored}` : search}`;
};

export function useList<T>(path: string, api: string, viewOf: (data: T) => ViewData) {
  const { search } = useLocation();
  const stored = storedView(path, search);
  useEffect(() => { if (stored) go(`${path}?${stored}`, { replace: true }); }, [path, stored]);
  const page = usePage<T>(listUrl(path, api, search));
  const data = page.data;
  useEffect(() => {
    if (!data) return;
    const view = viewOf(data);
    listView.set(path, view);
    remember(path, view.query);
    const address = addressOf(path, view.query, view.keep);
    if (address !== location.pathname + location.search) go(address, { replace: true });
  }, [data]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => listView.clear(), []);
  return page;
}
