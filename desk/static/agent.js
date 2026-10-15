// The Agent tab. A chat is Claude Code in a floating kitty window over desk (chats.py, window.py): the page
// lists the chats and starts new ones, and the Agent and history buttons at the bottom right of every page
// open them. A chat made before 15 Oct is drawn by desk on its own page, as Linear's Agent: its reply
// streams from /chats/<id>/stream as one JSON object per line: "text" pieces, "step" and "failed" for the
// agent's tool calls, then "done" with the reply drawn by the server. The reply runs on the server apart
// from the page, so a page that reloads mid-reply follows it again.
//
// It runs after desk.js and uses its esc, reason, keyOf, fold, menu, openMenu and openWindow. Its own names stay inside
// this function: classic scripts share one global scope, and desk.js already has a `page` and a `post`.

(() => {
  const postJSON = (url, data) => fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });

  const MODELS = [{ id: "haiku", label: "Haiku", hint: "Fastest, for quick answers" }, { id: "sonnet", label: "Sonnet", hint: "Everyday work" },
                  { id: "opus", label: "Opus", hint: "Hardest tasks, slower" }];
  const EFFORTS = [{ id: "", label: "Default" }, { id: "low", label: "Low" }, { id: "medium", label: "Medium" }, { id: "high", label: "High" },
                   { id: "xhigh", label: "Extra high" }, { id: "max", label: "Max" }];

  const EFFORT_GLYPHS = ["○", "◐", "●", "◉", "◈"]; // Claude Code's, low to max

  class Chat {
    // root holds .thread and .composer; scroller is what scrolls; onStart(chat) runs after a new chat's
    // first message and may return false to leave following the reply to another page.
    constructor(root, scroller, onStart) {
      this.root = root;
      this.scroller = scroller;
      this.onStart = onStart;
      this.id = root.dataset.chat || null;
      this.busy = false;
      this.thread = root.querySelector(".thread");
      this.form = root.querySelector(".composer");
      this.box = this.form.querySelector("textarea");
      this.button = this.form.querySelector(".send");
      this.chip = this.form.querySelector(".model");
      this.pickers = ["model", "effort"].map((n) => this.form.elements[n]);
      this.choose(root.dataset.chat ? root.dataset : null);
      this.chip.addEventListener("click", () => { if (justClosed !== this.chip) this.modelMenu(); });
      this.draft = `agentDraft:${root.id}`;
      this.box.value = sessionStorage[this.draft] || ""; // a reload keeps what you were typing
      let composing = false; // Enter while an input method composes (Vietnamese, fcitx5) is the method's
      this.box.addEventListener("compositionstart", () => { composing = true; });
      this.box.addEventListener("compositionend", () => { composing = false; });
      this.box.addEventListener("input", () => this.fit());
      this.box.addEventListener("keydown", (e) => {
        if (keyOf(e) === "Enter" && !e.shiftKey && !e.isComposing && !composing) { e.preventDefault(); this.form.requestSubmit(); }
      });
      this.form.addEventListener("submit", (e) => { e.preventDefault(); this.busy ? this.stop() : this.send(); });
      this.fit();
    }

    // Show a chat's saved model and effort; a new chat starts from the last choice made anywhere.
    choose(saved) {
      for (const pick of this.pickers) pick.value = saved ? saved[pick.name] ?? "" : localStorage[`agent:${pick.name}`] ?? (pick.name === "model" ? "haiku" : "");
      this.paint();
    }

    paint() {
      const [model, effort] = this.pickers.map((p) => p.value);
      this.chip.querySelector(".m").textContent = MODELS.find((m) => m.id === model)?.label ?? model;
      this.chip.querySelector(".e").textContent = EFFORTS.find((e) => e.id === effort)?.label ?? "";
    }

    set(pick, value) {
      pick.value = value;
      localStorage[`agent:${pick.name}`] = value;
      this.paint();
    }

    // The chip's menu, as Claude's: the models with a line each, then Effort, which opens its own list.
    modelMenu() {
      const [model, effort] = this.pickers, levels = EFFORTS.filter((e) => e.id);
      const step = (by) => { // ←/→ move along the bar; from the default, either key lands on the nearest end
        const at = levels.findIndex((e) => e.id === effort.value);
        this.set(effort, levels[Math.max(0, Math.min(levels.length - 1, at < 0 ? (by > 0 ? 1 : 0) : at + by))].id);
        paint();
      };
      this.chip.classList.add("open");
      openMenu({
        anchor: this.chip, className: "models", onClose: () => this.chip.classList.remove("open"), onArrow: step,
        items: () => MODELS.map((m) => ({ label: m.label, sub: m.hint, current: m.id === model.value, group: "model", run: () => this.set(model, m.id) })),
      });
      // Claude Code's effort line under the models: a glyph and the level's name, and a slider to drag
      // along its five stops or step with ←/→. Until a level is set, the thumb sits hollow at Medium.
      const bar = document.createElement("div");
      bar.className = "effort";
      bar.innerHTML = '<div class="effort-head"><span class="glyph"></span><span class="name"></span><button class="reset" type="button">Reset</button><kbd>←/→</kbd></div>' +
        `<div class="slider"><div class="rail"><div class="fill"></div>${levels.map((_, i) => `<i style="--f:${i / (levels.length - 1)}"></i>`).join("")}</div><b class="thumb"></b></div>`;
      menu.el.append(bar);
      const slider = bar.querySelector(".slider");
      const paint = () => {
        const at = levels.findIndex((e) => e.id === effort.value);
        bar.querySelector(".glyph").textContent = at < 0 ? "◌" : EFFORT_GLYPHS[at];
        bar.querySelector(".name").textContent = at < 0 ? "Default effort" : `${levels[at].label} effort`;
        bar.classList.toggle("unset", at < 0);
        slider.style.setProperty("--f", at < 0 ? 0.5 : at / (levels.length - 1));
      };
      const drag = (e) => {
        const box = slider.querySelector(".rail").getBoundingClientRect();
        const at = Math.round(Math.max(0, Math.min(1, (e.clientX - box.left) / box.width)) * (levels.length - 1));
        if (levels[at].id !== effort.value) { this.set(effort, levels[at].id); paint(); }
      };
      slider.addEventListener("pointerdown", (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        slider.setPointerCapture(e.pointerId);
        slider.classList.add("dragging");
        drag(e);
      });
      slider.addEventListener("pointermove", (e) => { if (slider.hasPointerCapture(e.pointerId)) drag(e); });
      slider.addEventListener("pointerup", () => slider.classList.remove("dragging"));
      bar.querySelector(".reset").addEventListener("mousedown", (e) => { e.preventDefault(); this.set(effort, ""); paint(); });
      paint();
    }

    fit() {
      this.box.style.height = "auto";
      this.box.style.height = `${this.box.scrollHeight}px`;
      this.button.disabled = !this.busy && !this.box.value.trim();
      sessionStorage[this.draft] = this.box.value;
    }

    scroll(force) {
      const s = this.scroller;
      if (force || s.scrollHeight - s.scrollTop - s.clientHeight < 120) s.scrollTop = s.scrollHeight;
    }

    note(text) {
      this.thread.insertAdjacentHTML("beforeend", `<p class="msg-error">${esc(text)}</p>`);
      this.scroll(true);
    }

    setBusy(on) {
      this.busy = on;
      this.form.classList.toggle("busy", on);
      this.button.ariaLabel = on ? "Stop" : "Send";
      this.button.dataset.tip = on ? "Stop" : "Send  Enter";
      this.fit();
    }

    async send() {
      const text = this.box.value.trim();
      if (!text || this.busy) return;
      const res = await postJSON(this.id ? `/chats/${this.id}/messages` : "/chats", { text, page: location.pathname, model: this.pickers[0].value, effort: this.pickers[1].value });
      if (!res.ok) { this.note(await reason(res)); return; }
      const chat = await res.json();
      this.box.value = "";
      this.fit();
      const first = !this.id;
      this.id = this.root.dataset.chat = chat.id;
      this.thread.insertAdjacentHTML("beforeend", `<div class="msg you"><div class="bubble">${esc(text)}</div></div>`);
      this.scroll(true);
      if (first && this.onStart(chat) === false) return;
      this.follow();
    }

    stop() {
      if (this.id) postJSON(`/chats/${this.id}/stop`, {});
    }

    // Show the reply as it streams: the agent's steps as they happen, its words under them.
    async follow() {
      const id = this.id;
      this.setBusy(true);
      const msg = document.createElement("div");
      msg.className = "msg agent";
      msg.innerHTML = '<div class="working-label">Working…</div><ul class="steps"></ul><div class="answer streaming"></div>';
      this.thread.append(msg);
      this.scroll(true);
      const steps = msg.querySelector(".steps"), answer = msg.querySelector(".answer");
      let text = "", seen = 0, over = false;
      const handle = (event) => {
        if (event.t === "text") { text += event.text; answer.textContent = text; }
        else if (event.t === "step") {
          if (text.trim()) steps.insertAdjacentHTML("beforeend", `<li class="text">${esc(text.trim())}</li>`);
          text = "";
          answer.textContent = "";
          steps.insertAdjacentHTML("beforeend", `<li class="tool" data-id="${esc(event.id)}">${esc(event.label)}</li>`);
        }
        else if (event.t === "failed") steps.querySelector(`[data-id="${CSS.escape(event.id)}"]`)?.classList.add("failed");
        else if (event.t === "done") { msg.outerHTML = event.html; over = true; }
        this.scroll();
      };
      while (!over && this.id === id) {
        try {
          const reader = (await fetch(`/chats/${id}/stream?start=${seen}`)).body.pipeThrough(new TextDecoderStream()).getReader();
          let buffer = "";
          for (let part = await reader.read(); !part.done; part = await reader.read()) {
            buffer += part.value;
            for (let nl = buffer.indexOf("\n"); nl >= 0; nl = buffer.indexOf("\n")) {
              const event = JSON.parse(buffer.slice(0, nl));
              buffer = buffer.slice(nl + 1);
              if (event.t === "idle") { // no reply under way: desk restarted and lost it
                msg.outerHTML = '<p class="msg-error">No reply: desk restarted while the agent was answering. Send it again.</p>';
                over = true;
                break;
              }
              seen += 1;
              handle(event);
            }
          }
        } catch { /* the connection dropped: follow again from the last event seen */ }
        if (!over) await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      if (this.id === id) this.setBusy(false);
    }
  }

  // Copying a reply.
  document.addEventListener("click", (e) => {
    const copy = e.target.closest(".copy");
    if (copy) navigator.clipboard.writeText(copy.dataset.text).then(() => { copy.dataset.tip = "Copied"; });
  });

  // The chats, in desk's menu, under the header's switcher or above the history button. A click on
  // the button whose menu is open closes it: desk.js closes it on mousedown, so note it on pointerdown.
  let shut = null;
  document.addEventListener("pointerdown", () => { shut = menu?.anchor ?? null; }, true);

  // A chat in a window opens its window over desk (desk.js's openWindow); one desk drew opens its page.
  const newChat = () => openWindow("/chats/window");
  const openChat = (c) => (c.window ? openWindow(`/chats/${c.id}/window`) : location.assign(c.url));

  function chatsMenu(anchor, current) {
    if (shut === anchor) return;
    const chats = fetch("/chats").then((res) => res.json());
    openMenu({
      anchor, className: "chats", filter: "keys", placeholder: "Switch chat…", empty: "No chat matches",
      items: async (query) => [
        { label: "New chat", group: "new", run: newChat },
        ...(await chats).filter((c) => fold(c.title).includes(fold(query)))
          .map((c) => ({ label: c.title, hint: c.working ? "Working" : c.age, current: c.id === current, group: "chats", run: () => openChat(c) })),
      ],
    });
  }

  // --- the Agent page: New chat and the chats; or a chat desk drew, on its own page ----------------
  const page = document.getElementById("agent");

  if (page?.dataset.chat) {
    // A change to the issues changes nothing in a chat: desk.js's soft refresh swaps only the sidebar
    // on a page that redraws itself, so a reply streaming here keeps its page.
    window.onIssuesChanged = () => {};
    const chat = new Chat(page, document.querySelector(".scroll"), (c) => { location.assign(c.url); return false; });
    chat.scroll(true);
    if (page.dataset.running === "1") chat.follow();
    chat.box.focus();
  } else if (page) {
    // The list shows a new chat once it has one: reload when its window has opened.
    page.querySelector(".new-chat").addEventListener("click", async () => { if (await newChat()) location.reload(); });
    page.addEventListener("click", (e) => {
      const row = e.target.closest("[data-window]");
      if (!row) return;
      e.preventDefault();
      openWindow(`/chats/${row.dataset.window}/window`);
    });
  }
  document.querySelector(".chat-switch")?.addEventListener("click", (e) => chatsMenu(e.currentTarget, page?.dataset.chat));

  // --- the buttons at the bottom right of every page ---------------------------------------------
  // Agent: the newest chat while it has taken on no issue yet, else a new one (chats.py, Open).
  document.querySelector(".dock-agent").addEventListener("click", () => openWindow("/chats/window", { fresh: true }));
  const historyButton = document.querySelector(".dock-history");
  historyButton.addEventListener("click", () => chatsMenu(historyButton, page?.dataset.chat));
})();
