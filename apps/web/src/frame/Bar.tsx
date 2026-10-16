// The top bar over a page's content (base.html's header.bar): the sidebar's toggle when it is hidden, the page's
// crumb, and its tools on the right.
import type { ReactNode } from "react";
import { SIDE_ICON } from "../ui/icons";
import { toggleSide } from "./side";

export function Bar({ crumb, tools, children }: { crumb?: ReactNode; tools?: ReactNode; children?: ReactNode }) {
  return (
    <header className="bar">
      <button className="side-icon side-toggle" type="button" title="Show sidebar  [" onClick={toggleSide}>{SIDE_ICON}</button>
      {crumb}
      {children}
      <span className="right">{tools}</span>
    </header>
  );
}
