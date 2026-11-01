// A chat's Browser, a view of its right half (Half.tsx): the tabs its session has open in the agents' Chrome, which the
// session host's relay notes and desk keeps (the server's tabs.ts), as a strip, then back, forward, reload and the open
// tab's address, then the page ("okay A", the user's pick from three mockups, 31 Oct). The strip has no new tab or ×:
// the tabs are the session's, opened and closed by Claude.
import { observer } from "mobx-react-lite";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { dock } from "../store/dock";
import { issues, type Tab } from "../store/issues";
import { GLYPH } from "../ui/icons";

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

// The tab's back, forward, reload and address, then its picture, live (the server's cast.ts), fit into the half: the tab
// is in a window of the agents' Chrome, the size Claude works in, which stays as it is. A tab in front of its window
// comes at the size the half shows it, in the screen's pixels, and a tab behind whole, at the screen's scale (cast.ts
// says why). desk restarting drops the socket, so it watches again, once a second for a minute, the last picture kept
// meanwhile.
function Page({ tab }: { tab: Tab }) {
  const shot = useRef<HTMLImageElement>(null), typed = useRef<HTMLTextAreaElement>(null), picker = useRef<HTMLInputElement>(null);
  const [stand, setStand] = useState<"waiting" | "on" | "away" | "failed">("waiting");
  const [moves, setMoves] = useState({ back: false, forward: false }); // where the tab can go in its history, as desk says
  const [editing, setEditing] = useState(false);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [chooser, setChooser] = useState<Chooser | null>(null);
  const [held, setHeld] = useState(false); // a box open in the page since before desk looked, which it cannot read
  const [giving, setGiving] = useState(""); // what is being given the page, while it goes
  const say = useRef<(said: object) => void>(() => {});
  const give = useRef<(files: File[]) => void>(() => {});
  // the tab's toolbar, as Chrome's: its buttons leave your keys with the page, and an address typed takes them back there
  const go = (said: object) => {
    say.current(said);
    typed.current?.focus({ preventScroll: true });
  };
  const button = (name: string, glyph: ReactNode, keys: string, can: boolean, nav: string) => (
    <button className="dock-btn" type="button" title={`${name}  ${keys}`} aria-label={name} disabled={!can || stand !== "on"}
      onMouseDown={(e) => e.preventDefault()} onClick={() => go({ nav })}>{glyph}</button>
  );
  useEffect(() => {
    const img = shot.current!, keys = typed.current!, pick = picker.current!, box = img.parentElement!;
    const size = () => ({ w: Math.round(box.clientWidth * devicePixelRatio), h: Math.round(box.clientHeight * devicePixelRatio) });
    let socket: WebSocket | null = null, gone = false, tries = 0, retry = 0, shown = "", next = "";
    // Each picture shows once it has loaded, and the one before it is let go then; one that came before it loaded is
    // dropped for the next.
    img.onload = () => {
      if (shown) URL.revokeObjectURL(shown);
      shown = next;
      next = "";
    };
    const watch = () => {
      const { w, h } = size();
      const ws = socket = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/tabs/${tab.target}/screen?w=${w}&h=${h}`);
      ws.binaryType = "blob";
      ws.onopen = () => { tries = 0; };
      ws.onmessage = (e) => {
        if (typeof e.data === "string") return told(JSON.parse(e.data) as Told);
        if (next) URL.revokeObjectURL(next);
        img.src = next = URL.createObjectURL(e.data as Blob);
        setStand("on");
      };
      ws.onclose = (e) => {
        if (gone || ws !== socket || e.code === 4404) return; // a tab that closed leaves the strip
        setStand("away");
        if (++tries <= 60) retry = window.setTimeout(watch, 1000);
        else setStand("failed");
      };
    };
    // What desk tells besides pictures: where the tab can go, and what the page asks of you, which takes your keys while
    // it waits and gives them back to the page once it is answered. A chooser opens your own file chooser at once, as
    // your click in the picture still lets the page do (a browser lets a page open one only just after a click).
    let asking = false; // a box or a chooser waits on you, which keeps the socket while desk is out of sight (cast.ts)
    const told = (m: Told) => {
      if ("dialog" in m) {
        setDialog(m.dialog ?? null);
        asking = Boolean(m.dialog);
        if (!m.dialog) keys.focus({ preventScroll: true });
      } else if ("held" in m) setHeld(Boolean(m.held));
      else if ("chooser" in m) {
        setChooser(m.chooser ?? null);
        setGiving("");
        if (m.chooser) {
          pick.multiple = m.chooser.multiple;
          pick.click();
        } else keys.focus({ preventScroll: true });
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
      keys.focus({ preventScroll: true });
    };
    pick.addEventListener("cancel", cancelled);
    // a half dragged wider, or the window, gets its pictures at the new size
    let wait = 0;
    const sized = new ResizeObserver(() => {
      clearTimeout(wait);
      wait = window.setTimeout(() => send(size()), 300);
    });
    sized.observe(box);

    // Your mouse and wheel on the picture go to the tab (the server's cast.ts), a place or a distance as a fraction of the
    // picture as drawn, which is fit into the box at its top. Only the left button: the right one would open Chrome's own
    // menu, which a headless Chrome draws nowhere. Moves and wheels go once a frame, added up.
    const spot = (e: MouseEvent) => {
      const r = img.getBoundingClientRect(), k = Math.min(r.width / (img.naturalWidth || 1), r.height / (img.naturalHeight || 1));
      const w = img.naturalWidth * k, h = img.naturalHeight * k, x = (e.clientX - r.left - (r.width - w) / 2) / w, y = (e.clientY - r.top) / h;
      return { x, y, w, h, on: w > 0 && x >= 0 && x <= 1 && y >= 0 && y <= 1 };
    };
    const mods = (e: MouseEvent | KeyboardEvent) => (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
    let held = false, frame = 0, move: object | null = null, rolled: { dx: number; dy: number; x: number; y: number; mods: number } | null = null;
    const flush = () => {
      cancelAnimationFrame(frame);
      frame = 0;
      if (move) send(move);
      if (rolled) send({ wheel: [rolled.dx, rolled.dy], x: rolled.x, y: rolled.y, mods: rolled.mods });
      move = rolled = null;
    };
    const later = () => { frame ||= requestAnimationFrame(flush); };
    const clamp = (n: number) => Math.min(Math.max(n, 0), 1);
    const hover = (e: MouseEvent) => {
      const at = spot(e);
      if (held || !at.on) return;
      move = { mouse: "move", x: at.x, y: at.y, mods: mods(e) };
      later();
    };
    const drag = (e: MouseEvent) => {
      const at = spot(e);
      move = { mouse: "move", x: clamp(at.x), y: clamp(at.y), held: true, mods: mods(e) };
      later();
    };
    const up = (e: MouseEvent) => {
      if (e.button !== 0) return;
      const at = spot(e);
      held = false;
      removeEventListener("mousemove", drag);
      removeEventListener("mouseup", up);
      flush();
      send({ mouse: "up", x: clamp(at.x), y: clamp(at.y), n: e.detail, mods: mods(e) });
    };
    const down = (e: MouseEvent) => {
      const at = spot(e);
      if (e.button !== 0 || !at.on) return;
      e.preventDefault();
      // the keys' box goes where you clicked, for an input method's list of words
      keys.style.left = `${e.clientX - box.getBoundingClientRect().left}px`;
      keys.style.top = `${e.clientY - box.getBoundingClientRect().top}px`;
      keys.focus({ preventScroll: true });
      held = true;
      addEventListener("mousemove", drag);
      addEventListener("mouseup", up);
      flush();
      send({ mouse: "down", x: at.x, y: at.y, n: e.detail, mods: mods(e) });
    };
    const wheel = (e: WheelEvent) => {
      const at = spot(e);
      if (e.ctrlKey || !at.on) return; // Ctrl and the wheel zooms desk, as it does elsewhere
      e.preventDefault();
      const px = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? at.h : 1;
      rolled = { dx: (rolled?.dx ?? 0) + (e.deltaX * px) / at.w, dy: (rolled?.dy ?? 0) + (e.deltaY * px) / at.h, x: at.x, y: at.y, mods: mods(e) };
      later();
    };
    // Your keys go to the tab from a box you cannot see, which a click on the picture puts them in, as xterm.js takes the
    // terminal's: a browser extension leaves keys typed into a text box alone, where it takes them from a picture as its
    // own (1 Nov: Vimium, in the agents' Chrome as in yours, took h, l, o, d and s, and its o opened its own search
    // bar). Each key goes but Ctrl ` and Ctrl ⇧ B, which go on to desk, as from the terminal (Terminal.tsx), and Ctrl V,
    // which pastes into the box: what an input method wrote there (fcitx5's Vietnamese) and what you pasted go to the
    // tab as text. Chrome's own keys for its toolbar do what they do there, since Chrome takes no key sent to a tab as
    // its own: Alt ← and Alt → go back and forward, Ctrl R and F5 reload, and Ctrl L goes to the address.
    const toolbar = (e: KeyboardEvent) => {
      const alone = !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey, ctrl = e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey;
      if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) return e.key === "ArrowLeft" ? "back" : "forward";
      if ((ctrl && e.code === "KeyR") || (alone && e.key === "F5")) return "reload";
      return ctrl && e.code === "KeyL" ? "address" : "";
    };
    const key = (e: KeyboardEvent) => {
      if (e.ctrlKey && !e.altKey && !e.metaKey && (e.code === "Backquote" || (e.shiftKey && e.code === "KeyB") || e.code === "KeyV")) return;
      if (e.isComposing || e.keyCode === 229) return; // the input method's
      e.preventDefault();
      e.stopPropagation();
      const pressed = e.type === "keydown", plain = !e.ctrlKey && !e.altKey && !e.metaKey, own = toolbar(e);
      if (own) {
        if (pressed && !e.repeat) {
          if (own === "address") setEditing(true);
          else send({ nav: own });
        }
        return;
      }
      const text = !pressed || !plain ? "" : e.key === "Enter" ? "\r" : [...e.key].length === 1 ? e.key : "";
      flush();
      send({ key: pressed ? "down" : "up", k: e.key, code: e.code, kc: e.keyCode, text, mods: mods(e) });
    };
    const write = (e: Event) => {
      if ((e as InputEvent).isComposing || !keys.value) return;
      flush();
      send({ insert: keys.value });
      keys.value = "";
    };
    const paste = (e: ClipboardEvent) => {
      e.preventDefault();
      const text = e.clipboardData?.getData("text/plain");
      if (text) send({ insert: text });
    };
    const menu = (e: MouseEvent) => e.preventDefault();
    img.addEventListener("mousedown", down);
    img.addEventListener("mousemove", hover);
    img.addEventListener("wheel", wheel, { passive: false });
    img.addEventListener("contextmenu", menu);
    keys.addEventListener("keydown", key);
    keys.addEventListener("keyup", key);
    keys.addEventListener("input", write);
    keys.addEventListener("compositionend", write);
    keys.addEventListener("paste", paste);
    return () => {
      gone = true;
      clearTimeout(retry);
      clearTimeout(wait);
      cancelAnimationFrame(frame);
      sized.disconnect();
      document.removeEventListener("visibilitychange", seen);
      removeEventListener("pagehide", away);
      pick.removeEventListener("cancel", cancelled);
      removeEventListener("mousemove", drag);
      removeEventListener("mouseup", up);
      for (const [name, on] of [["mousedown", down], ["mousemove", hover], ["wheel", wheel], ["contextmenu", menu]] as const) img.removeEventListener(name, on as EventListener);
      for (const [name, on] of [["keydown", key], ["keyup", key], ["input", write], ["compositionend", write], ["paste", paste]] as const) keys.removeEventListener(name, on as EventListener);
      socket?.close();
      for (const url of [shown, next]) if (url) URL.revokeObjectURL(url);
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
      <div className="browser-page">
        <img ref={shot} className="browser-shot" alt={tab.title || tab.url} draggable={false} hidden={stand === "waiting"} />
        <textarea ref={typed} className="browser-keys" aria-label="Keys to the page" autoComplete="off" autoCorrect="off" spellCheck={false} />
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
