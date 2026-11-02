// A chat's Browser, a view of its right half (Half.tsx), in desk's app alone (lib/desktop.ts): the tabs its session has
// open in desk's app, which the session host's relay notes and desk keeps (the server's tabs.ts), as a strip, then back,
// forward, reload and the open tab's address, then the page ("okay A", the user's pick from three mockups, 31 Oct). The
// strip has no new tab or ×: the tabs are the session's, opened and closed by Claude.
import { observer } from "mobx-react-lite";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { APP } from "../lib/desktop";
import { dock } from "../store/dock";
import { issues, type Tab } from "../store/issues";
import { ui } from "../store/ui";
import { GLYPH } from "../ui/icons";
import { toasts } from "../ui/toast";

export const BrowserView = observer(function BrowserView({ session }: { session: string }) {
  const tabs = issues.tabsOf(session);
  if (!tabs.length) return <p className="browser-empty">No tabs yet</p>;
  // The tab you picked, while it is open; else the one opened last, where Claude most likely works.
  const shown = tabs.find((t) => t.target === dock.tab[session]) ?? tabs[tabs.length - 1];
  return (
    <div className="browser">
      <div className="browser-tabs" role="tablist" aria-label="Tabs">
        {tabs.map((t) => (
          <button key={t.target} className={`browser-tab${t === shown ? " here" : ""}`} type="button" role="tab" aria-selected={t === shown}
            title={`${t.title || t.url}\n${t.url}`} onClick={() => dock.showTab(session, t.target)}>
            <Favicon tab={t} />
            <span>{t.title || where(t.url).host || t.url}</span>
          </button>
        ))}
      </div>
      <Page key={shown.target} tab={shown} />
    </div>
  );
});

// What the page asks of you that Chrome would draw outside it (cast.ts): an alert box, a confirm, a prompt or "Leave
// site?", and a file chooser your click opened.
type Dialog = { type: "alert" | "confirm" | "prompt" | "beforeunload"; message: string; prompt: string };
type Chooser = { multiple: boolean };
type Told = { dialog?: Dialog | null; held?: boolean; chooser?: Chooser | null; back?: boolean; forward?: boolean };
const BIGGEST = 100 * 1024 * 1024; // bytes in one file given a page: one message on desk's socket, as ws takes at most
// desk's own layers, which the tab would cover where they meet its box: its menus and popovers, search and the command
// menu, the @ menu, the boxes that create, the image viewer, the toast, a tooltip, a list's display options and its
// selection bar, the Browser's own cards, and the shortcuts panel (#keys). Each is a list the page keeps up to date,
// which costs nothing to read each frame (0.003 ms, where a query took 0.37, 1 Nov).
const LAYERS = ["menu", "at-menu", "creator", "viewer", "toast", "tip", "display-panel", "select-bar", "browser-held"].map((name) => document.getElementsByClassName(name));
const layered = (r: DOMRect) => [...LAYERS.flatMap((list) => [...list]), document.getElementById("keys")].some((el) => {
  const l = el?.getBoundingClientRect();
  return l && l.width && l.height && l.left < r.right && r.left < l.right && l.top < r.bottom && r.top < l.bottom;
});

// The tab's back, forward, reload and address, then the tab itself, which desk's app lays over the page's box (its
// tabs.ts), and a socket to desk for what Chrome draws outside the page (the server's cast.ts). desk restarting drops
// the socket, so it watches again, once a second for a minute.
function Page({ tab }: { tab: Tab }) {
  const shot = useRef<HTMLImageElement>(null), picker = useRef<HTMLInputElement>(null);
  const area = useRef<HTMLDivElement>(null);
  const [stand, setStand] = useState<"waiting" | "on" | "away" | "failed">("waiting");
  const [moves, setMoves] = useState({ back: false, forward: false }); // where the tab can go in its history, as desk says
  const [editing, setEditing] = useState(false);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [chooser, setChooser] = useState<Chooser | null>(null);
  const [held, setHeld] = useState(false); // a box open in the page since before desk looked, which it cannot read
  const [giving, setGiving] = useState(""); // what is being given the page, while it goes
  const say = useRef<(said: object) => void>(() => {});
  const give = useRef<(files: File[]) => void>(() => {});
  // the tab's toolbar, as Chrome's: its buttons leave your keys where they were
  const go = (said: object) => say.current(said);
  const button = (name: string, glyph: ReactNode, keys: string, can: boolean, nav: string) => (
    <button className="dock-btn" type="button" title={`${name}  ${keys}`} aria-label={name} disabled={!can || stand !== "on"}
      onMouseDown={(e) => e.preventDefault()} onClick={() => go({ nav })}>{glyph}</button>
  );
  useEffect(() => {
    const pick = picker.current!;
    let socket: WebSocket | null = null, gone = false, tries = 0, retry = 0;
    const watch = () => {
      const ws = socket = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/tabs/${tab.target}/screen`);
      ws.onopen = () => {
        tries = 0;
        setStand("on");
      };
      ws.onmessage = (e) => {
        if (typeof e.data === "string") told(JSON.parse(e.data) as Told);
      };
      ws.onclose = (e) => {
        if (gone || ws !== socket || e.code === 4404) return; // a tab that closed leaves the strip
        setStand("away");
        if (++tries <= 60) retry = window.setTimeout(watch, 1000);
        else setStand("failed");
      };
    };
    // What desk tells: where the tab can go, and what the page asks of you, which takes your keys while it waits. A
    // chooser opens your own file chooser at once, as your click in the tab still lets the page do (a browser lets a
    // page open one only just after a click).
    let asking = false; // a box or a chooser waits on you, which keeps the socket while desk is out of sight (cast.ts)
    const told = (m: Told) => {
      if ("dialog" in m) {
        setDialog(m.dialog ?? null);
        asking = Boolean(m.dialog);
      } else if ("held" in m) setHeld(Boolean(m.held));
      else if ("chooser" in m) {
        setChooser(m.chooser ?? null);
        setGiving("");
        if (m.chooser) {
          pick.multiple = m.chooser.multiple;
          pick.click();
        }
      } else setMoves({ back: Boolean(m.back), forward: Boolean(m.forward) });
    };
    watch();
    // desk out of sight lets go of the tab, and takes it back once you look again
    const seen = () => {
      if (!document.hidden) return void (socket || gone || watch());
      if (asking) return;
      const ws = socket;
      socket = null;
      clearTimeout(retry);
      ws?.close();
    };
    document.addEventListener("visibilitychange", seen);
    // desk's page put away whole, which a browser may keep with its sockets open for Back: let go of the tab, so that a
    // box your click opened is cancelled rather than left holding the page (cast.ts)
    const away = () => {
      const ws = socket;
      socket = null;
      ws?.close();
    };
    addEventListener("pagehide", away);
    const send = (said: object) => socket?.readyState === WebSocket.OPEN && socket.send(JSON.stringify(said));
    say.current = send;
    // the files for the chooser: their names, then each, as cast.ts takes them
    give.current = (files) => {
      if (socket?.readyState !== WebSocket.OPEN) return;
      socket.send(JSON.stringify({ files: files.map((f) => f.name) }));
      for (const f of files) socket.send(f);
    };
    // your own file chooser closed with none picked: none for the page either
    const cancelled = () => {
      send({ files: [] });
      setChooser(null);
    };
    pick.addEventListener("cancel", cancelled);
    return () => {
      gone = true;
      clearTimeout(retry);
      document.removeEventListener("visibilitychange", seen);
      removeEventListener("pagehide", away);
      pick.removeEventListener("cancel", cancelled);
      socket?.close();
    };
  }, [tab.target]);

  // The tab itself over the box, where the box is each frame: the app lays it there (its tabs.ts), and
  // puts it back as the Browser goes. While one of desk's own layers meets the box, a menu or a card here, which the tab
  // would cover, a picture of the tab shows in the box, and the tab stands aside, out of sight at its size, until the
  // layer goes: a still page under the layer, as Chrome's own menus leave it. A click on the picture puts away what
  // covers it, as a click beside a menu does, and the tab comes back. Ctrl L in the tab comes here, the tab hands it on,
  // and edits the address.
  useEffect(() => {
    if (!APP) return; // desk in a web page draws no Browser (Half.tsx)
    const box = area.current!, img = shot.current!;
    let frame = 0, was = "", over = false, still = false, asked = 0, hide = 0;
    // The picture shows once drawn, and the tab stands aside two frames later, once the window shows it in its place; one
    // that comes after the layer went is dropped.
    const freeze = async () => {
      const n = ++asked, bmp = await APP!.still(tab.target);
      if (n !== asked || !bmp) return;
      URL.revokeObjectURL(img.src);
      img.src = URL.createObjectURL(new Blob([bmp as Uint8Array<ArrayBuffer>], { type: "image/bmp" }));
      await img.decode().catch(() => {});
      if (n !== asked) return;
      clearTimeout(hide);
      img.hidden = false; // the app's picture is shown and hidden here, not by React, which drew it hidden
      await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
      if (n === asked) still = true;
    };
    // The tab comes back over the picture, which goes once it is surely covered.
    const thaw = () => {
      asked++;
      still = false;
      hide = window.setTimeout(() => { img.hidden = true; }, 100);
    };
    const place = () => {
      frame = requestAnimationFrame(place);
      const r = box.getBoundingClientRect(), shows = Boolean(r.width && r.height), under = shows && layered(r);
      if (under !== over) void ((over = under) ? freeze() : thaw());
      const at = { x: r.left, y: r.top, width: r.width, height: r.height }, now = JSON.stringify([at, still]);
      if (now === was) return;
      was = now;
      APP!.show(shows ? tab.target : null, at, still);
    };
    place();
    // A window hidden let go of its tab (main.ts), which it gets again as it shows.
    const seen = () => { if (document.visibilityState === "visible") was = ""; };
    document.addEventListener("visibilitychange", seen);
    const back = () => {
      toasts.hide();
      ui.setKeys(false);
    };
    const key = (e: KeyboardEvent) => {
      if (!e.ctrlKey || e.shiftKey || e.code !== "KeyL") return;
      e.preventDefault();
      e.stopPropagation();
      setEditing(true);
    };
    img.addEventListener("mousedown", back);
    box.addEventListener("keydown", key);
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(hide);
      asked++;
      img.removeEventListener("mousedown", back);
      box.removeEventListener("keydown", key);
      document.removeEventListener("visibilitychange", seen);
      URL.revokeObjectURL(img.src);
      APP!.show(null);
    };
  }, [tab.target]);
  const host = where(tab.url).host;
  const answer = (yes: boolean, text?: string) => {
    say.current({ answer: yes, ...(text === undefined ? {} : { text }) });
    setDialog(null);
  };
  const chosen = (files: File[]) => {
    const big = files.find((f) => f.size > BIGGEST);
    if (big) return setGiving(`${big.name} is over 100 MB, more than desk gives a page.`);
    setGiving(files.length ? `Giving the page ${files.length === 1 ? files[0].name : `${files.length} files`}…` : "");
    if (files.length) give.current(files);
    else {
      say.current({ files: [] });
      setChooser(null);
    }
  };
  return (
    <>
      <div className="browser-nav">
        {button("Back", GLYPH.back, "Alt ←", moves.back, "back")}
        {button("Forward", GLYPH.forward, "Alt →", moves.forward, "forward")}
        {button("Reload", GLYPH.reload, "Ctrl R", true, "reload")}
        <Address tab={tab} editing={editing} edit={setEditing} open={(url) => go({ open: url })} />
      </div>
      <div ref={area} className="browser-page" data-tab={tab.target}>
        <img ref={shot} className="browser-shot" alt={tab.title || tab.url} draggable={false} hidden />
        {(stand === "away" || stand === "failed") && <p className="term-note">{stand === "away" ? "Reconnecting…" : "desk does not answer."}</p>}
        {dialog && <DialogCard key={`${dialog.type} ${dialog.message}`} dialog={dialog} host={host} answer={answer} />}
        {held && !dialog && <HeldCard host={host} reload={() => { setHeld(false); go({ nav: "reload" }); }} />}
        {chooser && !dialog && <ChooserCard chooser={chooser} host={host} giving={giving} choose={() => picker.current?.click()} cancel={() => chosen([])} />}
        <input ref={picker} type="file" hidden onChange={(e) => {
          const files = [...(e.currentTarget.files ?? [])];
          e.currentTarget.value = "";
          if (files.length) chosen(files);
        }} />
      </div>
    </>
  );
}

// An alert box, a confirm, a prompt or "Leave site?", which holds the page until it is answered, drawn over its picture
// as the card of what waits on you (the chat's question card, .ask), in Chrome's words: "<site> says", then OK, and
// Cancel for all but an alert. Enter is OK and Esc Cancel; Claude may answer it first, which takes it away.
function DialogCard({ dialog, host, answer }: { dialog: Dialog; host: string; answer: (yes: boolean, text?: string) => void }) {
  const [text, setText] = useState(dialog.prompt);
  const card = useRef<HTMLFormElement>(null);
  useEffect(() => takeKeys(card.current!), []);
  const leave = dialog.type === "beforeunload";
  return (
    <div className="browser-held">
      <form ref={card} className="ask browser-ask" role="alertdialog" aria-label={leave ? "Leave site?" : `${host || "This page"} says`}
        onSubmit={(e) => {
          e.preventDefault();
          answer(true, dialog.type === "prompt" ? text : undefined);
        }}
        onKeyDown={(e) => {
          e.stopPropagation(); // the card's keys are its own, not desk's: Esc would leave the chat
          if (e.key !== "Escape") return;
          e.preventDefault();
          answer(dialog.type === "alert");
        }}>
        <span className="ask-header">{leave ? "Leave site?" : `${host || "This page"} says`}</span>
        <p className="ask-what">{leave ? "Changes you made may not be saved." : dialog.message}</p>
        {dialog.type === "prompt" && <input className="ask-other browser-prompt" value={text} onFocus={(e) => e.currentTarget.select()}
          onChange={(e) => setText(e.currentTarget.value)} aria-label="Answer" />}
        <div className="ask-buttons">
          {dialog.type !== "alert" && <button className="ghost" type="button" onClick={() => answer(false)}>Cancel</button>}
          <button className="primary" type="submit">{leave ? "Leave" : "OK"}</button>
        </div>
      </form>
    </div>
  );
}

// A box open in the page since before desk looked at it, which only the connection that heard it open can answer
// (cast.ts): the page answers nothing until it closes, and a reload closes it.
function HeldCard({ host, reload }: { host: string; reload: () => void }) {
  const card = useRef<HTMLDivElement>(null);
  useEffect(() => takeKeys(card.current!), []);
  return (
    <div className="browser-held">
      <div ref={card} className="ask browser-ask" role="alertdialog" aria-label="The page waits" onKeyDown={(e) => e.stopPropagation()}>
        <span className="ask-header">{host || "This page"}</span>
        <p className="ask-what">The page waits on a box that opened before desk looked at it, which desk cannot read. Claude may answer it; a reload closes it.</p>
        <div className="ask-buttons">
          <button className="primary" type="button" onClick={reload}>Reload page</button>
        </div>
      </div>
    </div>
  );
}

// A file chooser your click opened, which opened your own as well: this card stays for when it did not (a browser lets a
// page open one only just after a click), and says how giving the files goes.
function ChooserCard({ chooser, host, giving, choose, cancel }: { chooser: Chooser; host: string; giving: string; choose: () => void; cancel: () => void }) {
  const card = useRef<HTMLDivElement>(null);
  useEffect(() => takeKeys(card.current!), []);
  return (
    <div className="browser-held">
      <div ref={card} className="ask browser-ask" role="dialog" aria-label="File chooser" onKeyDown={(e) => {
        e.stopPropagation(); // the card's keys are its own, not desk's: Esc would leave the chat
        if (e.key === "Escape") cancel();
      }}>
        <span className="ask-header">{host || "This page"}</span>
        <p className="ask-what">{giving || (chooser.multiple ? "The page asks for files." : "The page asks for a file.")}</p>
        <div className="ask-buttons">
          <button className="ghost" type="button" onClick={cancel}>Cancel</button>
          <button className="primary" type="button" disabled={giving.startsWith("Giving")} onClick={choose}>{chooser.multiple ? "Choose files…" : "Choose file…"}</button>
        </div>
      </div>
    </div>
  );
}

// A card over the page takes your keys, on its field or its primary button, when they were in the Browser, not while
// you type in the chat beside it: Claude's own call may be what opened it.
function takeKeys(card: HTMLElement) {
  const was = document.activeElement;
  if (was && was !== document.body && !was.closest(".half")) return;
  card.querySelector<HTMLElement>("input, button.primary")?.focus({ preventScroll: true });
}

// The address as Chrome's bar shows it: the host brighter than the rest, any other address, such as data: or
// about:blank, whole. A click or Ctrl L edits it, the whole of it selected, Enter takes the tab there, and Esc or a
// click elsewhere puts it back.
function Address({ tab, editing, edit, open }: { tab: Tab; editing: boolean; edit: (on: boolean) => void; open: (url: string) => void }) {
  const { host, rest } = where(tab.url);
  if (editing) {
    return (
      <input className="browser-url editing" defaultValue={tab.url} aria-label="Address" autoFocus spellCheck={false} autoComplete="off"
        onFocus={(e) => e.currentTarget.select()} onBlur={() => edit(false)}
        onKeyDown={(e) => {
          if (e.key !== "Enter" || !e.currentTarget.value.trim()) return;
          open(address(e.currentTarget.value));
          edit(false);
        }} />
    );
  }
  return (
    <div className="browser-url" title={`${tab.url}\nEdit  Ctrl L`} onClick={() => edit(true)}>
      {host ? <><b>{host}</b>{rest}</> : tab.url.slice(0, 300)}
    </div>
  );
}

// What you typed in the address, as Chrome's bar takes it: an address as it is, a site with no scheme over https, one
// on this laptop or your network over http, and anything else a Google search.
const address = (typed: string) => {
  const s = typed.trim();
  if (/^(https?:\/\/|about:blank$)/i.test(s)) return s;
  if (/^(localhost|\d+\.\d+\.\d+\.\d+|\[[\da-f:]+\])(:\d+)?([/?#]|$)/i.test(s)) return `http://${s}`;
  if (!/\s/.test(s) && /^[^/?#:]+\.[a-z]{2,}(:\d+)?([/?#]|$)/i.test(s)) return `https://${s}`;
  return `https://www.google.com/search?q=${encodeURIComponent(s)}`;
};

const where = (url: string): { host: string; rest: string } => {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return { host: "", rest: "" };
    return { host: u.host, rest: `${u.pathname === "/" ? "" : u.pathname}${u.search}${u.hash}` };
  } catch {
    return { host: "", rest: "" };
  }
};

// The site's own icon, which desk fetches (the server's tabs.ts), or a globe where it finds none.
function Favicon({ tab }: { tab: Tab }) {
  const site = where(tab.url).host ? new URL(tab.url).origin : "";
  const [broken, setBroken] = useState("");
  if (!site || broken === site) return <span className="browser-fav">{GLYPH.globe}</span>;
  return <img className="browser-fav" src={`/api/tabs/${tab.target}/icon?site=${encodeURIComponent(site)}`} alt="" onError={() => setBroken(site)} />;
}
