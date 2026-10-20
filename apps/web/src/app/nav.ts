import { createElement, type AnchorHTMLAttributes, type ReactNode } from "react";
import { Link } from "react-router";

// desk's pages, all drawn by the app. A link to anything else under desk (a screenshot an issue keeps, a raw file)
// loads it as a plain link.
const PORTED = [/^\/issue\/[\w-]+$/, /^\/issues(\/(active|backlog))?$/, /^\/triage$/, /^\/backlog$/, /^\/teams$/, /^\/team\/[\w-]+(\/issues)?$/, /^\/$/,
  /^\/inbox$/, /^\/search$/, /^\/sessions$/, /^\/sessions\/[0-9a-f-]{36}$/, /^\/settings(\/[\w-]+)?$/, /^\/issue\/[\w-]+\/f\/[^/]+\.(md|d2)$/];

export const ported = (path: string) => PORTED.some((re) => re.test(new URL(path, location.origin).pathname));

// desk's path for the page the app shows now.
export const deskPath = (pathname = location.pathname) => pathname;

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
