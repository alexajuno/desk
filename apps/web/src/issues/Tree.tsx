// An issue's row, and a tree of them (templates/macros.html, row and tree). The row's two icons open the priority and
// status menus; right-click opens its actions; the mouse or J and K put it in focus, as in Linear. A row in a list is
// selected with X, Shift-click or the checkbox its left edge shows under the mouse (selection.tsx); a selected row's
// right-click acts on the whole selection.
import { observer } from "mobx-react-lite";
import type { ReactNode } from "react";
import { Go } from "../app/nav";
import { CLOSED, type IssueRow, type TreeRow } from "../lib/desk";
import { PrioIcon, StateIcon } from "../ui/icons";
import { toggled } from "../ui/menu";
import { ui } from "../store/ui";
import { painted } from "./painted";
import { actionsMenu, fieldMenu } from "./menus";
import { selectionMenu, selectTo } from "./selection";

export const Row = observer(function Row({ issue, context = false, here = null, children }: { issue: IssueRow; context?: boolean; here?: string | null; children?: ReactNode }) {
  const p = painted(issue);
  const icon = (field: "priority" | "state") => (e: React.MouseEvent) => {
    e.preventDefault(); // the row is a link
    if (!toggled(e.currentTarget)) fieldMenu(p.slug, field, p[field], { anchor: e.currentTarget });
  };
  const selected = ui.selected.has(p.slug);
  return (
    <Go to={`/issue/${p.slug}`} className={`item${context ? " context" : ""}${ui.focused === p.slug ? " focus" : ""}${selected ? " selected" : ""}`}
      data-slug={p.slug} data-state={p.state} data-priority={p.priority} data-parent={p.parent ?? ""}
      onMouseMove={() => { if (ui.focused !== p.slug) ui.focus(p.slug, true); }}
      onClick={(e) => {
        if (!e.shiftKey) return;
        e.preventDefault(); // Linear's Shift-click selects, where a browser opens the link in a window
        selectTo(p.slug);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        ui.focus(p.slug);
        if (selected) selectionMenu({ x: e.clientX, y: e.clientY });
        else actionsMenu(p, { x: e.clientX, y: e.clientY }, here);
      }}>
      <span className="select-box" role="checkbox" aria-checked={selected} aria-label="Select" title="Select  X"
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); if (e.shiftKey) selectTo(p.slug); else ui.toggleSelect(p.slug); }}>
        <svg viewBox="0 0 16 16" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3.5 8.5l3 3 6-7" /></svg>
      </span>
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
