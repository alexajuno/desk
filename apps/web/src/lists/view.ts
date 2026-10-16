// A list's view: Linear's Filter and Display options (desk/views.py). The view lives in the page's address, in words
// (/backlog?folder=muse&priority=not:low,none&group=status), and only what differs from the page's defaults is
// written. The app keeps each page's last view in this browser (localStorage.views), so the sidebar's bare /backlog
// opens it again, as the old pages kept it in a cookie.
import { go } from "../app/nav";

export interface Field {
  name: string;
  label: string;
  icon: string;
  values: { value: string; label: string; icon: string; count: number }[];
}

export interface ViewData {
  query: string;
  defaults: Record<string, string>;
  default: boolean; // the display is the page's default
  keep: string[];
  noun: string;
  display: { key: string; label: string; options: Record<string, string> }[];
  switches: string[];
  fields: Field[];
  filters: Record<string, { not: boolean; values: string[] }>;
  group: string;
  order: string;
  done?: string;
  subs?: string;
  reverse: boolean;
  empty: boolean;
  [key: string]: unknown;
}

export interface Filter {
  not: boolean;
  values: string[];
}

// The words views.py reads; any of them in the address means it carries a view.
const WORDS = new Set(["status", "priority", "project", "folder", "protocol", "issue", "group", "order", "done", "subs", "reverse", "empty"]);
export const hasView = (search: string) => [...new URLSearchParams(search).keys()].some((k) => WORDS.has(k));

// The words views.py writes keep their slashes, tildes, commas and colons, as in folder=genai/api.
export const readable = (params: URLSearchParams) =>
  params.toString().replace(/%2F/gi, "/").replace(/%7E/gi, "~").replace(/%2C/gi, ",").replace(/%3A/gi, ":");

const stored = (): Record<string, string> => JSON.parse(localStorage.views ?? "{}");
export const lastView = (path: string) => stored()[path] ?? "";
export function remember(path: string, query: string) {
  const all = stored();
  if (query) all[path] = query;
  else delete all[path];
  localStorage.views = JSON.stringify(all);
}

// The page's address for a view's query, with the page's own words that are no view's, such as the Sessions search.
export function addressOf(path: string, query: string, keep: string[] = []) {
  const here = new URLSearchParams(location.search), own = new URLSearchParams();
  for (const name of keep) if (here.has(name)) own.set(name, here.get(name)!);
  const all = [query, readable(own)].filter(Boolean).join("&");
  return path + (all ? `?${all}` : "");
}

// changes: a word to its new value; null, false or the page's default drops it from the address.
export function setView(path: string, v: ViewData, changes: Record<string, string | boolean | null>) {
  const params = new URLSearchParams(v.query);
  for (const [name, value] of Object.entries(changes)) {
    if (value == null || value === false || value === v.defaults[name]) params.delete(name);
    else params.set(name, value === true ? "1" : value);
  }
  const query = readable(params);
  remember(path, query);
  go(addressOf(path, query, v.keep), { replace: true });
}

export const setFilter = (path: string, v: ViewData, name: string, filter: Filter | null) =>
  setView(path, v, { [name]: filter?.values.length ? (filter.not ? "not:" : "") + filter.values.join(",") : null });

export function toggleValue(path: string, v: ViewData, name: string, value: string) {
  const was = v.filters[name] ?? { not: false, values: [] };
  return setFilter(path, v, name, { ...was, values: was.values.includes(value) ? was.values.filter((x) => x !== value) : [...was.values, value] });
}
