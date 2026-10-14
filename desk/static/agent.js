// The Agent tab: chats with desk's agent, on its own page and in a panel on every other page, as
// Linear's Agent. A reply streams from /chats/<id>/stream as one JSON object per line: "text" pieces,
// "step" and "failed" for the agent's tool calls, then "done" with the reply drawn by the server. The
// reply runs on the server apart from the page, so a page that reloads mid-reply follows it again.

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const post = (url, data) => fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });

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
    this.draft = `agentDraft:${root.id}`;
    this.box.value = sessionStorage[this.draft] || "";  // a reload keeps what you were typing
    this.box.addEventListener("input", () => this.fit());
    this.box.addEventListener("keydown", (e) => {
      // Enter sends, Shift+Enter breaks the line; an input method (Vietnamese via fcitx5) uses Enter itself.
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); this.form.requestSubmit(); }
    });
    this.form.addEventListener("submit", (e) => { e.preventDefault(); this.busy ? this.stop() : this.send(); });
    this.fit();
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
    this.root.toggleAttribute("data-busy", on);  // base.html's reload-on-change waits while this is set
    this.button.title = on ? "Stop" : "Send (Enter)";
    this.fit();
  }

  async send() {
    const text = this.box.value.trim();
    if (!text || this.busy) return;
    const res = await post(this.id ? `/chats/${this.id}/messages` : "/chats", { text, page: location.pathname });
    if (!res.ok) { this.note((await res.json().catch(() => ({}))).detail || "Could not send."); return; }
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
    if (this.id) post(`/chats/${this.id}/stop`, {});
  }

  // Show the reply as it streams: the agent's steps as they happen, its words under them.
  async follow() {
    const id = this.id;  // the panel may switch to another chat while this one answers
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
        text = ""; answer.textContent = "";
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
            if (event.t === "idle") {  // no reply under way: desk restarted and lost it
              msg.outerHTML = '<p class="msg-error">No reply: desk restarted while the agent was answering. Send it again.</p>';
              over = true;
              break;
            }
            seen += 1;
            handle(event);
          }
        }
      } catch (e) { /* the connection dropped: follow again from the last event seen */ }
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

// --- the list of chats, under the header's switcher or above the history button ----------------
let chatMenu = null;

function closeChats() {
  if (chatMenu) { chatMenu.remove(); chatMenu = null; }
}

async function openChats(anchor, current, pick) {
  if (chatMenu?.anchor === anchor) { closeChats(); return; }
  closeChats();
  const chats = [{ id: "", title: "New chat", age: "" }, ...await (await fetch("/chats")).json()];
  chatMenu = document.createElement("div");
  chatMenu.className = "menu chats";
  chatMenu.anchor = anchor;
  chatMenu.innerHTML = "<ul>" + chats.map((c, i) => `<li class="${i ? "" : "on"}" data-id="${esc(c.id)}"><span class="name">${esc(c.title)}</span>` +
    `${c.id && c.id === current ? '<span class="now">Current</span>' : ""}<span class="age">${esc(c.age)}</span></li>`).join("") + "</ul>";
  document.body.append(chatMenu);
  const box = anchor.getBoundingClientRect(), above = box.top > innerHeight / 2;
  Object.assign(chatMenu.style, { position: "fixed", left: `${Math.max(8, Math.min(box.left, innerWidth - 328))}px` },
    above ? { bottom: `${innerHeight - box.top + 6}px`, left: `${Math.max(8, box.right - 320)}px` } : { top: `${box.bottom + 4}px` });
  const items = [...chatMenu.querySelectorAll("li")];
  let at = 0;
  const mark = (i) => { items[at].classList.remove("on"); at = i; items[at].classList.add("on"); };
  items.forEach((li, i) => li.addEventListener("mousemove", () => mark(i)));
  chatMenu.addEventListener("mousedown", (e) => {
    const li = e.target.closest("li");
    if (li) { e.preventDefault(); closeChats(); pick(li.dataset.id || null); }
  });
  chatMenu.keys = (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") mark((at + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length);
    else if (e.key === "Enter") { closeChats(); pick(items[at].dataset.id || null); }
    else if (e.key === "Escape") closeChats();
    else return;
    e.preventDefault();
    e.stopPropagation();
  };
}

document.addEventListener("mousedown", (e) => {
  if (chatMenu && !chatMenu.contains(e.target) && !chatMenu.anchor.contains(e.target)) closeChats();
}, true);
document.addEventListener("keydown", (e) => chatMenu?.keys(e), true);

// --- the Agent page --------------------------------------------------------------------------
const page = document.getElementById("agent");
const goTo = (id) => location.assign(id ? `/agent/${id}` : "/agent");

if (page) {
  const chat = new Chat(page, document.querySelector(".scroll"), (c) => { location.assign(c.url); return false; });
  chat.scroll(true);
  if (page.dataset.running === "1") chat.follow();
  chat.box.focus();
  const examples = page.querySelector(".examples");
  if (examples && localStorage.agentExamples === "hidden") examples.remove();
  page.querySelector(".examples .dismiss")?.addEventListener("click", () => { localStorage.agentExamples = "hidden"; examples.remove(); });
  document.querySelector(".chat-switch")?.addEventListener("click", (e) => openChats(e.currentTarget, chat.id, goTo));
}

// --- the panel and the buttons at the bottom right of every page ------------------------------
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
  title.textContent = "New chat";
  expand.href = "/agent";
  panel.classList.toggle("started", !!id);
  remember();
  if (!id) return;
  const res = await fetch(`/chats/${id}`);
  if (!res.ok) { showInPanel(null); return; }
  const chat = await res.json();
  panelChat.thread.innerHTML = chat.html;
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
  const saved = JSON.parse(sessionStorage.agentPanel || "{}");  // the panel stays open, on its chat, across pages
  if (saved.open) openPanel(saved.chat || null);
  dockAgent.addEventListener("click", () => (panel.hidden ? openPanel(panelChat ? undefined : saved.chat || null) : closePanel()));
  panel.querySelector(".panel-close").addEventListener("click", closePanel);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !panel.hidden && !document.querySelector(".menu, .viewer")) closePanel();
  });
} else {
  dockAgent.addEventListener("click", () => page?.querySelector(".composer textarea").focus());
}

document.querySelector(".dock-history").addEventListener("click", (e) =>
  openChats(e.currentTarget, panel ? panelChat?.id : page?.dataset.chat, panel ? (id) => openPanel(id) : goTo));
