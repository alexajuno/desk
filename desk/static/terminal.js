// The issue's session in a terminal on its own page: xterm.js here, a websocket to desk/terminal.py,
// and there a PTY running the claude command Jump back runs in kitty. "Open here" opens it to the
// right of the issue. Closing it, or the page, hangs up the PTY: `claude attach` ends and the
// background session keeps running. Kept apart from desk.js and the Agent tab; it uses desk.js's $ and
// page. xterm.js and the terminal's CSS load on the first open, so other pages never fetch them.
//
// Keys: every key goes to Claude Code, none to desk's shortcuts, except Ctrl+Z, which claude takes as
// "suspend me and drop back to your shell"; here there is no shell to drop back to.
// In a normal Chrome window Chrome takes Ctrl+W, Ctrl+T, Ctrl+N, Ctrl+Tab and Ctrl+PgUp/PgDn before
// the page sees them (BrowserCommandController::IsReservedCommandOrKey), so while the terminal has the
// focus, leaving the page asks first: Ctrl+W meant to delete a word does not close desk. An app window
// (google-chrome --app=http://localhost:8790) reserves no keys, and they all reach Claude Code.

(() => {
  // The colours are terminal.css's --term-* variables. xterm.js takes hex, and desk's colours are
  // lch(), so a 1px canvas converts them.
  const NAMES = ["background", "foreground", "cursor", "selectionBackground", "black", "red", "green", "yellow", "blue", "magenta",
                 "cyan", "white", "brightBlack", "brightRed", "brightGreen", "brightYellow", "brightBlue", "brightMagenta", "brightCyan", "brightWhite"];
  const pixel = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  const hex = (css) => {
    pixel.clearRect(0, 0, 1, 1);
    pixel.fillStyle = css;
    pixel.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = pixel.getImageData(0, 0, 1, 1).data;
    return "#" + [r, g, b, ...(a < 255 ? [a] : [])].map((v) => v.toString(16).padStart(2, "0")).join("");
  };
  const theme = () => {
    const style = getComputedStyle(document.documentElement);
    const colours = Object.fromEntries(NAMES.map((name) => [name, hex(style.getPropertyValue(`--term-${name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`))]));
    return { ...colours, cursorAccent: colours.background };
  };
  const encode = (text) => new TextEncoder().encode(text);
  let open = null; // { slug, el, xterm, ws, ended }

  const load = (tag, attrs) => new Promise((done, fail) => document.head.append(Object.assign(document.createElement(tag), attrs, { onload: done, onerror: fail })));
  let loading = null;
  const ready = () => (loading ??= Promise.all([
    load("script", { src: "/static/xterm/xterm.js" }).then(() => load("script", { src: "/static/xterm/addon-fit.js" })),
    load("link", { rel: "stylesheet", href: "/static/xterm/xterm.css" }),
    load("link", { rel: "stylesheet", href: "/static/terminal.css" }),
  ]));

  async function show(slug, short, trust = false) {
    if (open?.slug === slug && open.trust === trust) {
      if (open.ended) reconnect();
      return open.xterm.focus();
    }
    if (open) await shut();
    await ready();
    const panel = $(".panel");
    const el = document.createElement("section");
    el.className = "term";
    el.innerHTML = '<div class="term-grip" title="Drag to resize"></div>' +
      `<header><span class="term-title">Session <code></code></span><span class="term-command"></span>` +
      '<button class="icon-button term-close" type="button" title="Close the terminal. A background session keeps running.">' +
      '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/></svg></button></header>' +
      '<div class="term-screen"></div>';
    el.querySelector(".term-title").firstChild.textContent = trust ? "Trust folder " : "Session ";
    if (trust) el.querySelector(".term-title code").remove();
    else el.querySelector(".term-title code").textContent = short;
    if (localStorage.termWidth) panel.style.setProperty("--term-w", `${localStorage.termWidth}px`);
    panel.append(el);
    panel.classList.add("has-term");

    const xterm = new Terminal({ fontFamily: '"JetBrains Mono", "JetBrainsMono Nerd Font Mono", "Noto Sans Mono", monospace',
                                 fontSize: 13, lineHeight: 1.2, cursorBlink: true, scrollback: 5000, theme: theme() });
    const fit = new FitAddon.FitAddon();
    xterm.loadAddon(fit);
    xterm.open(el.querySelector(".term-screen"));
    fit.fit();
    open = { slug, el, xterm, trust, ws: null, ended: false };

    xterm.attachCustomKeyEventHandler((e) => !(e.ctrlKey && !e.altKey && !e.metaKey && e.code === "KeyZ"));
    xterm.onData((data) => {
      if (open?.xterm !== xterm) return;
      if (open.ended) { if (data === "\r") reconnect(); }
      else send(encode(data));
    });
    xterm.onBinary((data) => send(Uint8Array.from(data, (c) => c.charCodeAt(0))));
    xterm.onResize(({ cols, rows }) => send(JSON.stringify({ resize: [cols, rows] })));
    new ResizeObserver(() => requestAnimationFrame(() => open?.xterm === xterm && fit.fit())).observe(el.querySelector(".term-screen"));
    el.addEventListener("keydown", (e) => e.stopPropagation()); // keeps desk's shortcuts (Esc goes back, S, P…) out of it
    el.querySelector(".term-close").addEventListener("click", () => shut());
    grip(el.querySelector(".term-grip"), panel);
    connect();
    xterm.focus();
  }

  function connect() {
    const { slug, xterm } = open;
    const ws = new WebSocket(`${location.origin.replace(/^http/, "ws")}/issue/${encodeURIComponent(slug)}/terminal?cols=${xterm.cols}&rows=${xterm.rows}${open.trust ? "&trust=1" : ""}`);
    ws.binaryType = "arraybuffer";
    ws.onmessage = (e) => {
      if (typeof e.data !== "string") return xterm.write(new Uint8Array(e.data));
      open.el.querySelector(".term-command").textContent = JSON.parse(e.data).command ?? "";
    };
    ws.onclose = () => {
      if (open?.ws !== ws) return;
      open.ended = true;
      // on a fresh last line, under whatever claude drew last
      xterm.write("\x1b[0m\x1b[999;1H\r\n\x1b[2mClosed. Press Enter to open it again.\x1b[0m");
    };
    Object.assign(open, { ws, ended: false });
  }

  function reconnect() {
    open.xterm.reset();
    connect();
  }

  function send(data) {
    if (open?.ws?.readyState === WebSocket.OPEN) open.ws.send(data);
  }

  // Asks the server to hang up and waits until it has, so a form sent next (Hand off, Jump back) finds
  // the session no longer open here.
  async function shut() {
    if (!open) return;
    const { ws, el, xterm } = open;
    open = null;
    if (ws.readyState === WebSocket.OPEN) {
      const gone = new Promise((done) => ws.addEventListener("close", done));
      ws.send(JSON.stringify({ close: true }));
      await Promise.race([gone, new Promise((done) => setTimeout(done, 3000))]);
    }
    ws.close();
    xterm.dispose();
    el.remove();
    $(".panel").classList.remove("has-term");
  }

  function grip(handle, panel) {
    handle.addEventListener("pointerdown", (e) => {
      handle.setPointerCapture(e.pointerId);
      handle.onpointermove = (m) => {
        const box = panel.getBoundingClientRect(), width = Math.round(Math.min(Math.max(box.right - m.clientX, 420), box.width - 360));
        panel.style.setProperty("--term-w", `${width}px`);
        localStorage.termWidth = width;
      };
      handle.onpointerup = () => { handle.onpointermove = null; };
    });
  }

  document.addEventListener("click", (e) => {
    const button = e.target.closest(".term-open");
    if (!button) return;
    e.preventDefault();
    show(button.dataset.slug, button.dataset.short, !!button.dataset.trust);
  });

  // The session's own forms close the terminal first, so its claude is gone before desk acts on the session.
  document.addEventListener("submit", async (e) => {
    const form = e.target;
    // getAttribute: the review form has a button named "action", which hides form.action
    if (!open || !/\/(plan|handoff|review|jump)$/.test(form.getAttribute("action") ?? "")) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    await shut();
    form.requestSubmit(e.submitter);
  }, true);

  // Leaving the page hangs up at once. Without this, a page navigated to about:blank kept its socket open,
  // and its claude attach running (seen 14 Oct; Chrome's back/forward cache keeps a page it left alive).
  addEventListener("pagehide", () => open?.ws?.close());

  addEventListener("beforeunload", (e) => {
    if (open && !open.ended && open.el.contains(document.activeElement)) e.preventDefault();
  });

  // A theme picked while the terminal is open recolours it; claude keeps the colours it chose at its start.
  new MutationObserver(() => { if (open) open.xterm.options.theme = theme(); }).observe(document.documentElement, { attributeFilter: ["data-theme"] });

  // A soft refresh that leaves the issue (a delete moves to its parent) closes its terminal.
  new MutationObserver(() => { if (open && page()?.slug !== open.slug) shut(); }).observe($(".scroll"), { childList: true });
})();
