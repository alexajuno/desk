// A chat's terminal, one view of its right half (Half.tsx): xterm.js drawing the chat's tmux session, which desk's
// server starts when you or Claude open it and attaches to through a PTY (apps/server/src/terminal.ts). What you type
// goes to the shell, and Claude types into the same session with tt. tmux keeps the history: xterm.js keeps none, and
// passes the wheel and a drag to tmux, which scrolls, and copies through the clipboard (OSC 52, the clipboard addon).
// Shift and a drag selects in xterm.js instead, which Ctrl ⇧ C copies.
import { ClipboardAddon, type IClipboardProvider } from "@xterm/addon-clipboard";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal as XTerm, type ITheme } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef, useState } from "react";
import { postJson, reason } from "../api/http";
import { dock } from "../store/dock";

// Where the session stands, as the view says it while it is not on.
type Stand = "starting" | "on" | "away" | "failed";

// The terminal of the session's chat, which ended() hides once its shell has exited.
export function TerminalView({ session, ended }: { session: string; ended: () => void }) {
  const host = useRef<HTMLDivElement>(null);
  const [stand, setStand] = useState<Stand>("starting");
  const [failure, setFailure] = useState("");

  useEffect(() => {
    const term = new XTerm({ fontFamily: token("--term-font"), fontSize: 13, lineHeight: 1.2, scrollback: 0, cursorBlink: true, theme: theme() });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new ClipboardAddon(undefined, CLIPBOARD));
    term.open(host.current!);
    fit.fit();
    const yours = dock.yours(session);
    if (yours) term.focus();

    // Ctrl ` goes on to desk, which hides the half, and Ctrl ⇧ B, which shows the browser (Frame.tsx); Ctrl ⇧ C copies xterm.js's own selection, and Ctrl ⇧ V
    // is left to the browser, whose paste xterm.js takes, as a Linux terminal's keys.
    term.attachCustomKeyEventHandler((e) => {
      if (e.ctrlKey && !e.altKey && !e.metaKey && (e.code === "Backquote" || (e.shiftKey && e.code === "KeyB"))) return false;
      if (e.ctrlKey && e.shiftKey && (e.code === "KeyC" || e.code === "KeyV")) {
        if (e.type === "keydown" && e.code === "KeyC" && term.hasSelection()) void navigator.clipboard.writeText(term.getSelection());
        return false;
      }
      return true;
    });

    let socket: WebSocket | null = null, gone = false, tries = 0, retry = 0;
    const send = (said: object) => socket?.readyState === WebSocket.OPEN && socket.send(JSON.stringify(said));
    term.onData((keys) => send({ in: keys }));
    term.onResize(({ cols, rows }) => send({ cols, rows }));

    // Attach to the session. desk restarting drops the socket while tmux keeps the session, so it attaches again,
    // once a second for a minute; a session that is gone hides the half.
    const attach = () => {
      const ws = socket = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/live/${session}/terminal/screen?cols=${term.cols}&rows=${term.rows}`);
      ws.onopen = () => { tries = 0; setStand("on"); };
      ws.onmessage = (e) => term.write(e.data as string);
      ws.onclose = (e) => {
        if (gone || ws !== socket) return;
        if (e.reason === "ended") return ended();
        if (e.code === 4404) { setFailure(e.reason); return setStand("failed"); }
        setStand("away");
        if (++tries <= 60) retry = window.setTimeout(attach, 1000);
        else { setFailure("desk does not answer."); setStand("failed"); }
      };
    };
    // You opening it starts the session. Claude started it before opening it, and one left open as the page loads
    // only attaches, so a terminal that ended meanwhile, with its shell or its issue, hides rather than starting again.
    if (!yours) attach();
    else void (async () => {
      const res = await postJson(`/api/live/${session}/terminal`);
      if (gone) return;
      if (!res.ok) { setFailure(await reason(res)); return setStand("failed"); }
      attach();
    })();

    // The panel's size, as the window or the grip changes it, is the terminal's, in whole cells.
    let frame = 0;
    const sized = new ResizeObserver(() => { cancelAnimationFrame(frame); frame = requestAnimationFrame(() => fit.fit()); });
    sized.observe(host.current!);
    // and its colours are the theme's, light or dark
    const themed = new MutationObserver(() => { term.options.theme = theme(); });
    themed.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

    return () => {
      gone = true;
      clearTimeout(retry);
      cancelAnimationFrame(frame);
      sized.disconnect();
      themed.disconnect();
      socket?.close();
      term.dispose();
    };
  }, [session, ended]);

  return (
    <div className="term">
      <div className="term-screen" ref={host} />
      {stand !== "on" && stand !== "starting" && (
        <p className="term-note">{stand === "away" ? "Reconnecting…" : failure || "The terminal did not start."}</p>
      )}
    </div>
  );
}

// What tmux copies reaches the clipboard. tmux names no clipboard in what it sends (OSC 52 ";;", seen 31 Oct), which
// the addon's own provider drops, taking only "c". Nothing in the terminal reads the clipboard: only a paste gives it.
const CLIPBOARD: IClipboardProvider = {
  readText: () => "",
  writeText: (_which, text) => navigator.clipboard.writeText(text),
};

// A token's value, as the page's theme has it now.
const token = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

// A colour token as #rrggbb, which xterm.js reads: desk's are lch(), resolved through a canvas.
const paint = document.createElement("canvas").getContext("2d", { willReadFrequently: true })!;
function hex(name: string): string {
  paint.clearRect(0, 0, 1, 1);
  paint.fillStyle = "#000";
  paint.fillStyle = token(name);
  paint.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = paint.getImageData(0, 0, 1, 1).data;
  return `#${[r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("")}${a < 255 ? a.toString(16).padStart(2, "0") : ""}`;
}

const ANSI = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"] as const;

// The terminal's colours: its ground and text are the panel's, and its sixteen colours desk's --term-0 to --term-15
// (dock.css).
function theme(): ITheme {
  const t: ITheme = { background: hex("--bg-panel"), foreground: hex("--text-2"), cursor: hex("--text-1"), cursorAccent: hex("--bg-panel"),
    selectionBackground: hex("--bg-active") };
  ANSI.forEach((name, n) => {
    const bright = `bright${name[0].toUpperCase()}${name.slice(1)}` as keyof ITheme;
    (t as Record<string, string>)[name] = hex(`--term-${n}`);
    (t as Record<string, string>)[bright] = hex(`--term-${n + 8}`);
  });
  return t;
}
