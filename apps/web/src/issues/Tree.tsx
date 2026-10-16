// An issue's row, and a tree of them (templates/macros.html, row and tree). The row's two icons open the priority and
// status menus; right-click opens its actions; the mouse or J and K put it in focus, as in Linear.
import { observer } from "mobx-react-lite";
import type { ReactNode } from "react";
import { Go } from "../app/nav";
import { CLOSED, type IssueRow, type TreeRow } from "../lib/desk";
import { PrioIcon, StateIcon } from "../ui/icons";
import { toggled } from "../ui/menu";
import { ui } from "../store/ui";
import { painted } from "./painted";
import { actionsMenu, fieldMenu } from "./menus";

export const Row = observer(function Row({ issue, context = false, here = null, children }: { issue: IssueRow; context?: boolean; here?: string | null; children?: ReactNode }) {
  const p = painted(issue);
  const icon = (field: "priority" | "state") => (e: React.MouseEvent) => {
    e.preventDefault(); // the row is a link
    if (!toggled(e.currentTarget)) fieldMenu(p.slug, field, p[field], { anchor: e.currentTarget });
  };
  return (
    <Go to={`/issue/${p.slug}`} className={`item${context ? " context" : ""}${ui.focused === p.slug ? " focus" : ""}`}
      data-slug={p.slug} data-state={p.state} data-priority={p.priority} data-parent={p.parent ?? ""}
      onMouseMove={() => { if (ui.focused !== p.slug) ui.focus(p.slug, true); }}
      onContextMenu={(e) => {
        e.preventDefault();
        ui.focus(p.slug);
        actionsMenu(p, { x: e.clientX, y: e.clientY }, here);
      }}>
      <span className="icon" data-field="priority" title="Change priority  P" onClick={icon("priority")}><PrioIcon level={p.priority} /></span>
      <span className="icon" data-field="state" title="Change status  S" onClick={icon("state")}><StateIcon state={p.state} /></span>
      <span className="title">{p.title}</span>
      {p.state === "waiting" && (
        <>
          <span className="waiting-on" title={`${p.waiting_on || "Waiting"}, since ${p.waiting_since_short}`}>{p.waiting_on || "Waiting"}</span>
          <span className="waiting-for">{p.waited}</span>
        </>
      )}
      {children}
    </Go>
  );
});

export function Tree({ items, context = [], here = null }: { items: (TreeRow & { context?: boolean })[]; context?: string[]; here?: string | null }) {
  return (
    <ul className="tree">
      {items.map((p) => (
        <li key={p.slug}>
          <Row issue={p} context={p.context || context.includes(p.slug)} here={here}>
            {p.open > 0 && <span className="pill">{`${p.open} open`}</span>}
            <span className="spacer" /><span className="date">{p.created_short}</span>
          </Row>
          {p.kids.length > 0 && <Tree items={p.kids} context={context} here={here} />}
        </li>
      ))}
    </ul>
  );
}

export const isOpen = (state: string) => !CLOSED.includes(state as never);
