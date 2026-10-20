// Linear's Board layout (linear.app/docs/board-layout): a column per group, each issue a card. Dragging a card to
// another column sets what the board is grouped by, as Linear's does: its status, priority, team, project or folder. Landing
// takes no drop, since only Approve lands an issue, and says so while a card is dragged; a drop on Waiting asks on whom, as the S menu does. A card is a row
// as well: hover or J and K put it in focus for S, P and right-click, and X selects it.
import { observer } from "mobx-react-lite";
import { useState } from "react";
import { Go } from "../app/nav";
import type { TreeRow } from "../lib/desk";
import { setField, setFolder } from "../issues/actions";
import { actionsMenu, fieldMenu, waitingMenu } from "../issues/menus";
import { painted } from "../issues/painted";
import { selectionMenu, selectTo } from "../issues/selection";
import { ui, type CreatorPreset } from "../store/ui";
import { PLUS, PrioIcon, StateIcon } from "../ui/icons";
import { toggled } from "../ui/menu";
import { iconOf, type Group, type ListData } from "./parts";

type Card = TreeRow & { context?: boolean; subs?: [number, number] | null };

// Every issue of a group, each a card: the server sends a board's rows flat, but a list's nesting is undone too.
function cardsOf(items: Card[]): Card[] {
  return items.flatMap((p) => [...(p.context ? [] : [p]), ...cardsOf(p.kids as Card[])]);
}

// A folder group's name back to its path: the repos under ~/projects go by their path there.
const folderPath = (name: string) => (name === "none" ? "" : /^[~/]/.test(name) ? name : `~/projects/${name}`);

// What a drop on a column sets, or why it can't.
function dropOf(group: string, value: string): { run: (slug: string, at: { x: number; y: number }) => Promise<unknown> } | { refuse: string } {
  if (group === "status") {
    if (value === "landing") return { refuse: "Only Approve lands an issue." };
    if (value === "triage") return { refuse: "Only a chat files an issue in Triage." };
    return { run: async (slug, at) => { await setField(slug, "state", value); if (value === "waiting") waitingMenu(slug, "", at); } };
  }
  if (group === "priority") return { run: (slug) => setField(slug, "priority", value) };
  if (group === "team") return { run: (slug) => setField(slug, "team", value === "none" ? "" : value) };
  if (group === "project") return { run: (slug) => setField(slug, "project", value === "none" ? "" : value) };
  if (group === "folder") return { run: (slug) => setFolder(slug, folderPath(value)) };
  return { refuse: "Group the board to move cards between columns." };
}

const valueOf = (group: string, p: Card) =>
  ({ status: p.state, priority: p.priority, team: p.team ?? "none", project: p.project ?? "none" } as Record<string, string>)[group];

export const Board = observer(function Board({ list, empty }: { list: ListData; empty: string }) {
  const group = list.view.group;
  const [dragging, setDragging] = useState<Card | null>(null);
  const [over, setOver] = useState<string | null>(null);
  if (!list.groups.length) return <p className="muted list-empty">{list.hidden ? `${list.hidden} issue${list.hidden !== 1 ? "s" : ""} hidden by filters` : empty}</p>;
  return (
    <div className="board" onDragEnd={() => { setDragging(null); setOver(null); }}>
      {list.groups.map((g) => {
        const drop = dropOf(group, g.value), home = dragging && valueOf(group, dragging) === g.value;
        const takes = dragging && !home && "run" in drop;
        return (
          <section key={g.value} className={`column${over === g.value && takes ? " over" : ""}${dragging && !home && !takes ? " refuses" : ""}`}
            data-group={g.value}
            onDragOver={(e) => { if (!takes) return; e.preventDefault(); e.dataTransfer.dropEffect = "move"; if (over !== g.value) setOver(g.value); }}
            onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver(null); }}
            onDrop={(e) => {
              e.preventDefault();
              const card = dragging;
              setDragging(null);
              setOver(null);
              if (!card || !("run" in drop)) return;
              void drop.run(card.slug, { x: e.clientX, y: e.clientY });
            }}>
            <ColumnHead g={g} grouped={list.grouped} />
            {dragging && !home && "refuse" in drop && <p className="column-refuse">{drop.refuse}</p>}
            <div className="cards">
              {cardsOf(g.items as Card[]).map((p) => <CardView key={p.slug} card={p} onDrag={setDragging} />)}
            </div>
          </section>
        );
      })}
    </div>
  );
});

function ColumnHead({ g, grouped }: { g: Group; grouped: boolean }) {
  return (
    <header className="column-head">
      {iconOf(g.icon)}<span className="column-name">{grouped ? g.label : "All issues"}</span><span className="count">{g.count}</span>
      {g.preset && <button className="group-add" type="button" title="New issue" onClick={() => ui.openCreator(g.preset as CreatorPreset)}>{PLUS}</button>}
    </header>
  );
}

const CardView = observer(function CardView({ card, onDrag }: { card: Card; onDrag: (c: Card | null) => void }) {
  const p = painted(card);
  const selected = ui.selected.has(p.slug);
  const icon = (field: "priority" | "state") => (e: React.MouseEvent) => {
    e.preventDefault(); // the card is a link
    if (!toggled(e.currentTarget)) fieldMenu(p.slug, field, p[field], { anchor: e.currentTarget });
  };
  const folder = p.folder?.replace(/\/+$/, "").replace(/^~\/projects\//, "").replace(/^\/home\/[^/]+\/projects\//, "");
  return (
    <Go to={`/issue/${p.slug}`} className={`item card${ui.focused === p.slug ? " focus" : ""}${selected ? " selected" : ""}`} draggable
      data-slug={p.slug} data-state={p.state} data-priority={p.priority} data-parent={p.parent ?? ""}
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/uri-list", `${location.origin}/issue/${p.slug}`);
        onDrag(card);
      }}
      onMouseMove={() => { if (ui.focused !== p.slug) ui.focus(p.slug, true); }}
      onClick={(e) => { if (!e.shiftKey) return; e.preventDefault(); selectTo(p.slug); }}
      onContextMenu={(e) => {
        e.preventDefault();
        ui.focus(p.slug);
        if (selected) selectionMenu({ x: e.clientX, y: e.clientY });
        else actionsMenu(p, { x: e.clientX, y: e.clientY }, null);
      }}>
      <span className="card-top">
        <span className="icon" data-field="state" title="Change status  S" onClick={icon("state")}><StateIcon state={p.state} /></span>
        <span className="title">{p.title}</span>
      </span>
      <span className="card-props">
        <span className="icon" data-field="priority" title="Change priority  P" onClick={icon("priority")}><PrioIcon level={p.priority} /></span>
        {p.state === "waiting" && <span className="card-chip" title={`Waiting since ${p.waiting_since_short}`}>{p.waiting_on || "Waiting"} · {p.waited}</span>}
        {folder && <span className="card-chip">{folder}</span>}
        {card.subs && <span className="card-chip" title="Sub-issues done">{`${card.subs[0]}/${card.subs[1]}`}</span>}
        <span className="spacer" /><span className="date">{p.created_short}</span>
      </span>
    </Go>
  );
});
