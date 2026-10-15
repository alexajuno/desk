// The Agent tab: chats with desk's agent, on its own page and in a panel on every other page, as
// Linear's Agent. A reply streams from /chats/<id>/stream as one JSON object per line: "text" pieces,
// "step" and "failed" for the agent's tool calls, then "done" with the reply drawn by the server. The
// reply runs on the server apart from the page, so a page that reloads mid-reply follows it again.
//
// It runs after desk.js and uses its esc, reason, typing, keyOf, fold, menu and openMenu. Its own names stay inside this
// function: classic scripts share one global scope, and desk.js already has a `page` and a `post`.

(() => {
  const postJSON = (url, data) => fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });

  const MODELS = [{ id: "haiku", label: "Haiku", hint: "Fastest, for quick answers" }, { id: "sonnet", label: "Sonnet", hint: "Everyday work" },
                  { id: "opus", label: "Opus", hint: "Hardest tasks, slower" }];
  const EFFORTS = [{ id: "", label: "Default" }, { id: "low", label: "Low" }, { id: "medium", label: "Medium" }, { id: "high", label: "High" },
                   { id: "xhigh", label: "Extra high" }, { id: "max", label: "Max" }];

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
      const [model, effort] = this.pickers, open = (o) => { this.chip.classList.add("open"); openMenu({ ...o, anchor: this.chip, className: "models", onClose: () => this.chip.classList.remove("open") }); };
      open({ items: () => [
        ...MODELS.map((m) => ({ label: m.label, sub: m.hint, current: m.id === model.value, group: "model", run: () => this.set(model, m.id) })),
        { label: "Effort", hint: EFFORTS.find((e) => e.id === effort.value)?.label ?? "", more: true, group: "effort", run: () => open({ items: () => [
          { label: "‹ Back", group: "back", run: () => this.modelMenu() },
          ...EFFORTS.map((e) => ({ label: e.label, current: e.id === effort.value, group: "levels", run: () => this.set(effort, e.id) })),
        ] }) },
      ] });
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
      this.button.title = on ? "Stop" : "Send (Enter)";
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
      const id = this.id; // the panel may switch to another chat while this one answers
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

  // Clicks shared by the page and the panel: example prompts, copying a reply.
  document.addEventListener("click", (e) => {
    const example = e.target.closest("[data-prompt]");
    if (example) {
      const box = example.closest(".agent").querySelector(".composer textarea");
      box.value = example.dataset.prompt;
      box.focus();
      box.setSelectionRange(box.value.length, box.value.length);
      box.dispatchEvent(new Event("input"));
    }
    const copy = e.target.closest(".copy");
    if (copy) navigator.clipboard.writeText(copy.dataset.text).then(() => { copy.title = "Copied"; });
  });

  // The chats, in desk's menu, under the header's switcher or above the history button. A click on
  // the button whose menu is open closes it: desk.js closes it on mousedown, so note it on pointerdown.
  let shut = null;
  document.addEventListener("pointerdown", () => { shut = menu?.anchor ?? null; }, true);

  function chatsMenu(anchor, current, pick) {
    if (shut === anchor) return;
    const chats = fetch("/chats").then((res) => res.json());
    openMenu({
      anchor, className: "chats", filter: "keys", placeholder: "Switch chat…", empty: "No chat matches",
      items: async (query) => [
        { label: "New chat", group: "new", run: () => pick(null) },
        ...(await chats).filter((c) => fold(c.title).includes(fold(query)))
          .map((c) => ({ label: c.title, hint: c.age, current: c.id === current, group: "chats", run: () => pick(c.id) })),
      ],
    });
  }

  // --- the Agent page ---------------------------------------------------------------------------
  const page = document.getElementById("agent");
  const goTo = (id) => location.assign(id ? `/agent/${id}` : "/agent");

  if (page) {
    // A change to the issues changes nothing in a chat: desk.js's soft refresh swaps only the sidebar
    // on a page that redraws itself, so a reply streaming here keeps its page.
    window.onIssuesChanged = () => {};
    const chat = new Chat(page, document.querySelector(".scroll"), (c) => { location.assign(c.url); return false; });
    chat.scroll(true);
    if (page.dataset.running === "1") chat.follow();
    chat.box.focus();
    const examples = page.querySelector(".examples");
    if (examples && localStorage.agentExamples === "hidden") examples.remove();
    page.querySelector(".examples .dismiss")?.addEventListener("click", () => { localStorage.agentExamples = "hidden"; examples.remove(); });
    document.querySelector(".chat-switch")?.addEventListener("click", (e) => chatsMenu(e.currentTarget, chat.id, goTo));
  }

  // --- the panel and the buttons at the bottom right of every page ----------------------------
  const panel = document.getElementById("agent-panel");
  const dockAgent = document.querySelector(".dock-agent");
  let panelChat = null;

  function remember() {
    sessionStorage.agentPanel = JSON.stringify({ open: !panel.hidden, chat: panelChat?.id || null });
  }

  async function showInPanel(id) {
    const title = panel.querySelector(".panel-title"), expand = panel.querySelector("a.icon-button");
    panelChat.id = panel.dataset.chat = id || "";
    panelChat.setBusy(false);
    panelChat.thread.innerHTML = "";
    panelChat.choose(null);
    title.textContent = "New chat";
    expand.href = "/agent";
    panel.classList.toggle("started", !!id);
    remember();
    if (!id) return;
    const res = await fetch(`/chats/${id}`);
    if (!res.ok) { showInPanel(null); return; }
    const chat = await res.json();
    panelChat.thread.innerHTML = chat.html;
    panelChat.choose(chat);
    title.textContent = chat.title;
    expand.href = `/agent/${id}`;
    panelChat.scroll(true);
    if (chat.running) panelChat.follow();
  }

  function openPanel(id) {
    panel.hidden = false;
    dockAgent.classList.add("on");
    if (!panelChat) {
      panelChat = new Chat(panel, panel.querySelector(".panel-scroll"), (c) => {
        panel.classList.add("started");
        panel.querySelector(".panel-title").textContent = c.title;
        panel.querySelector("a.icon-button").href = c.url;
        remember();
      });
    }
    if (id !== undefined && (id || "") !== (panelChat.id || "")) showInPanel(id);
    remember();
    panelChat.box.focus();
  }

  function closePanel() {
    panel.hidden = true;
    dockAgent.classList.remove("on");
    remember();
  }

  if (panel) {
    const saved = JSON.parse(sessionStorage.agentPanel || "{}"); // the panel stays open, on its chat, across pages
    if (saved.open) openPanel(saved.chat || null);
    dockAgent.addEventListener("click", () => (panel.hidden ? openPanel(panelChat ? undefined : saved.chat || null) : closePanel()));
    panel.querySelector(".panel-close").addEventListener("click", closePanel);
    // Esc closes the panel before desk.js's Esc acts (on an issue, it goes back). An open menu, or a
    // text box outside the panel, keeps its own Esc.
    addEventListener("keydown", (e) => {
      const elsewhere = typing(document.activeElement) && !panel.contains(document.activeElement);
      if (keyOf(e) !== "Escape" || panel.hidden || e.isComposing || elsewhere || document.querySelector(".menu, .viewer")) return;
      closePanel();
      e.preventDefault();
      e.stopImmediatePropagation();
    }, true);
  } else {
    dockAgent.addEventListener("click", () => page?.querySelector(".composer textarea").focus());
  }

  const historyButton = document.querySelector(".dock-history");
  historyButton.addEventListener("click", () =>
    chatsMenu(historyButton, panel ? panelChat?.id : page?.dataset.chat, panel ? (id) => openPanel(id) : goTo));
})();
