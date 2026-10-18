// Keyboard shortcuts, as Linear's panel (templates/keys.html, measured on linear.app on 2026-10-15): a title, a
// search box, then groups of rows, each a name and its keys. In a row's keys, "then" separates the keys of a sequence
// and "or" two ways to the same thing; any other word is a key cap. Ctrl / or the Help menu opens it; typing keeps the
// rows whose name, keys or group name hold every word typed, and hides a group left with none.
import { observer } from "mobx-react-lite";
import { useEffect, useRef, useState } from "react";
import { fold } from "../lib/desk";
import { ui } from "../store/ui";

const GROUPS: [string, [string, string][]][] = [
  ["General", [["Open search", "/"], ["Create an issue", "C"], ["View keyboard shortcuts", "Ctrl /"], ["Close, or go back from an issue", "Esc"], ["Undo a delete", "Ctrl Z"]]],
  ["Navigation", [["Toggle left sidebar", "["], ["Go to inbox", "G then I"], ["Go to triage", "G then T"], ["Go to all issues", "G then E"], ["Go to active issues", "G then A"], ["Go to backlog", "G then B"], ["Go to projects", "G then P"], ["Open settings", "Ctrl ,"]]],
  ["List", [["Move down", "J or ↓"], ["Move up", "K or ↑"], ["Open the issue", "Enter"], ["Collapse or expand the group", "T"], ["Collapse or expand all of them", "Alt Click"], ["Filter", "F"], ["Display options", "Shift V"], ["Switch between list and board", "Ctrl B"]]],
  ["Selection", [["Select the issue", "X or Shift Click"], ["Select up or down", "Shift ↑ or Shift ↓"], ["Select all", "Ctrl A"], ["Change their status", "S"], ["Change their priority", "P"], ["Delete them", "Ctrl Delete"], ["Actions on them", "Right-click"], ["Clear the selection", "Esc"]]],
  ["Issues", [["Next step: Plan, Approve", "Ctrl Enter"], ["Open chat", "O"], ["Open chat, in the Inbox", "Enter then Enter"],["Hide or show the issue beside its chat", "]"], ["Accept, in Triage", "1"], ["Decline, in Triage", "2"], ["Mark as duplicate, in Triage", "3"], ["Park, in Triage", "4"], ["Change status", "S"], ["Change priority", "P"], ["Delete the issue", "Ctrl Delete"], ["Actions on a row", "Right-click"], ["Save the title", "Enter"], ["Save the description", "Ctrl Enter"]]],
  ["Chat", [["Type in the chat", "I"], ["Leave the composer, for desk's keys", "Esc"], ["Send, or queue while Claude works", "Enter"], ["Edit the queued messages", "↑"], ["New line", "Shift Enter"], ["Stop Claude", "Ctrl C"]]],
  ["Sessions", [["New session, from any page", "Ctrl ⇧ O"]]],
  ["New issue panel", [["From the title to the description", "Enter"], ["Create the issue", "Ctrl Enter"], ["Close, keeping a draft", "Esc"]]],
  ["Menus", [["Filter", "Type"], ["Move", "↑ or ↓"], ["Pick", "Enter or 1-9"], ["Close", "Esc"]]],
];

const CROSS = (size: number) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor"><path d="M2.97 2.97a.75.75 0 0 1 1.06 0L8 6.94l3.97-3.97a.75.75 0 1 1 1.06 1.06L9.06 8l3.97 3.97a.75.75 0 1 1-1.06 1.06L8 9.06l-3.97 3.97a.75.75 0 0 1-1.06-1.06L6.94 8 2.97 4.03a.75.75 0 0 1 0-1.06z" /></svg>
);

export const KeysPanel = observer(function KeysPanel() {
  const [text, setText] = useState("");
  const box = useRef<HTMLInputElement>(null);
  const open = ui.keysOpen;
  useEffect(() => {
    if (open) { setText(""); box.current?.focus(); }
  }, [open]);
  const words = fold(text).split(/\s+/).filter(Boolean);
  const shown = GROUPS.map(([group, rows]) => [group, rows.filter(([label, keys]) => words.every((w) => fold(`${group} ${label}${keys}`).includes(w)))] as const);
  return (
    <aside id="keys" aria-label="Keyboard shortcuts" hidden={!open}>
      <header><h1>Keyboard Shortcuts</h1>
        <button className="keys-close" type="button" aria-label="Close" title="Close  Esc" onClick={() => ui.setKeys(false)}>{CROSS(16)}</button></header>
      <form className="keys-search" onSubmit={(e) => e.preventDefault()}>
        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path fillRule="evenodd" d="M7 2a5 5 0 0 1 4.03 7.96l2.75 2.76a.75.75 0 1 1-1.06 1.06l-2.76-2.75A5 5 0 1 1 7 2zm0 1.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7z" /></svg>
        <input ref={box} type="text" placeholder="Search shortcuts" aria-label="Search shortcuts" autoComplete="off" spellCheck={false} value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Escape") { ui.setKeys(false); e.currentTarget.blur(); } }} />
        <button className="keys-clear" type="button" aria-label="Clear" hidden={!text} onClick={() => { setText(""); box.current?.focus(); }}>{CROSS(12)}</button>
      </form>
      <div className="keys-list">
        {shown.map(([group, rows]) => (
          <section key={group} hidden={!rows.length}><h2>{group}</h2>
            {rows.map(([label, keys]) => (
              <div className="key-row" key={label}><span>{label}</span><span className="seq">
                {keys.split(" ").map((key, i) => (key === "then" || key === "or" ? <span className="then" key={i}>{key}</span> : <kbd key={i}>{key}</kbd>))}
              </span></div>
            ))}
          </section>
        ))}
        <p className="keys-none" hidden={shown.some(([, rows]) => rows.length)}>No shortcuts found</p>
      </div>
    </aside>
  );
});
