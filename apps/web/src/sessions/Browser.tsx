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

// The tab's back, forward, reload and address, then its picture, live (the server's cast.ts), fit into the half: the tab
// is in the agents' Chrome's window, the size Claude works in, which stays as it is. The tab in front of that window
// comes at the size the half shows it, in the screen's pixels, and a tab behind it whole, at the screen's scale (cast.ts
// says why). desk restarting drops the socket, so it watches again, once a second for a minute, the last picture kept
// meanwhile.
function Page({ tab }: { tab: Tab }) {
  const shot = useRef<HTMLImageElement>(null), typed = useRef<HTMLTextAreaElement>(null);
  const [stand, setStand] = useState<"waiting" | "on" | "away" | "failed">("waiting");
  const [moves, setMoves] = useState({ back: false, forward: false }); // where the tab can go in its history, as desk says
  const [editing, setEditing] = useState(false);
  const say = useRef<(said: object) => void>(() => {});
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
    const img = shot.current!, keys = typed.current!, box = img.parentElement!;
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
        if (typeof e.data === "string") return setMoves(JSON.parse(e.data) as { back: boolean; forward: boolean });
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
    watch();
    const send = (said: object) => socket?.readyState === WebSocket.OPEN && socket.send(JSON.stringify(said));
    say.current = send;
    // a half dragged wider, or the window, gets its pictures at the new size
    let wait = 0;
    const sized = new ResizeObserver(() => {
      clearTimeout(wait);
      wait = window.setTimeout(() => send(size()), 300);
    });
    sized.observe(box);

    // Your mouse and wheel on the picture go to the tab (the server's cast.ts), a place or a distance as a fraction of the
    // picture as drawn, which is fit into the box at its top. Only the left button: the right one would open Chrome's own
    // menu, out of sight on workspace 8. Moves and wheels go once a frame, added up.
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
      removeEventListener("mousemove", drag);
      removeEventListener("mouseup", up);
      for (const [name, on] of [["mousedown", down], ["mousemove", hover], ["wheel", wheel], ["contextmenu", menu]] as const) img.removeEventListener(name, on as EventListener);
      for (const [name, on] of [["keydown", key], ["keyup", key], ["input", write], ["compositionend", write], ["paste", paste]] as const) keys.removeEventListener(name, on as EventListener);
      socket?.close();
      for (const url of [shown, next]) if (url) URL.revokeObjectURL(url);
    };
  }, [tab.target]);
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
      </div>
    </>
  );
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
