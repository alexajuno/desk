import { createElement, type AnchorHTMLAttributes, type ReactNode } from "react";
import { Link } from "react-router";

// The app lives at /app beside the old pages until it takes them over (sub-issue 5). Each page moves when it is
// built; until then a link to it loads the old page. Paths here are desk's own (/issue/x), never /app/...
export const BASE = "/app";
const PORTED = [/^\/issue\/[\w-]+$/];

export const ported = (path: string) => PORTED.some((re) => re.test(new URL(path, location.origin).pathname));

// desk's path for the page the app shows now: /app/issue/x is /issue/x.
export const deskPath = (pathname = location.pathname) => pathname.startsWith(BASE) ? pathname.slice(BASE.length) || "/" : pathname;

// A link to one of desk's pages: inside the app when the page lives here, else a plain link to the old page.
export function Go({ to, children, ...rest }: { to: string; children?: ReactNode } & AnchorHTMLAttributes<HTMLAnchorElement>) {
  return ported(to) ? createElement(Link, { to, ...rest }, children) : createElement("a", { href: to, ...rest }, children);
}

// Moves to one of desk's pages: inside the app when it lives here, else by loading the old page. main.tsx gives it
// the router's navigate.
let navigate: (to: string, opts?: { replace?: boolean }) => unknown = (to) => { location.href = to; };
export const setNavigate = (fn: typeof navigate) => { navigate = fn; };
export function go(to: string, opts?: { replace?: boolean }) {
  if (ported(to)) navigate(to, opts);
  else location.href = to;
}
