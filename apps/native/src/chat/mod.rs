// An issue's chat in the page, under its head (main.rs), as the web app's (apps/web/src/sessions/Dock.tsx): its
// conversation, live over the session's socket (live.rs), a column a document's width; under it what runs beside the
// conversation, the questions waiting on the user, and the composer, whose Enter sends or queues while Claude works.
//
// The conversation is a list of rows, each one message, one fold of Claude's tool steps, or what streams in now, laid
// out again only from the first row a change touched (rows_of, relayout).
mod ask;
mod composer;
mod turn;

use std::collections::{HashMap, HashSet};
use std::hash::{DefaultHasher, Hash, Hasher};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use gpui_kit::base::StyledExt;
use gpui_kit::component::input::{InputEvent, InputState, TextareaState};
use gpui_kit::component::message_scroller::{MessageScroller, MessageScrollerState};
use gpui_kit::component::text::TextView;
use gpui_kit::component::ActiveTheme;
use gpui_kit::prelude::FluentBuilder;
use gpui_kit::*;
use serde_json::Value;

use crate::live::{self, Ask, Attachment, Block, Event, Item, Model, Running};
use crate::net;
use crate::picker::Picker;
use crate::theme;

// The web app's chat column and text (desk.css).
const COLUMN: f32 = 760.;
const DOCUMENT: f32 = 15.;

// A message sent and not yet in the transcript: drawn at once, and gone once Claude Code writes it down. One sent
// while Claude works waits in its queue.
struct Pending {
    text: String,
    files: usize,
    mid: bool,
}

#[derive(Clone, PartialEq, Hash)]
enum Kind {
    You(usize),
    Text(usize),
    Note(usize),
    Sent(usize, String), // a Bash call that sent a step or a section of the issue's document: what it sent
    Steps(Vec<usize>, bool), // a fold of tool steps and thoughts, and whether it takes the steps streaming now
    LiveSteps,               // the steps streaming now, when no fold of the reply's own takes them
    Streaming(usize),        // a text block streaming now, by its place among them
    Pending(usize),
    Working,
}

#[derive(Clone, PartialEq)]
struct Row {
    kind: Kind,
    sig: u64, // what its look depends on beyond its kind, so a row that changed is laid out again
}

pub struct Chat {
    session: Option<String>,
    items: Vec<Item>,
    results: HashMap<String, Item>, // a tool step's result, by the step's id
    partial: Vec<Block>,
    working: bool,
    since: u64,
    asks: Vec<Ask>,
    tasks: Vec<Running>,
    status: Value,
    meta: Value,
    pending: Vec<Pending>,
    error: Option<String>,
    rows: Vec<Row>,
    // what the user opened or closed: folds by their first item's key; a step's detail, a thought, a command's
    // whole output by the item's key
    closed: HashSet<String>,
    opened: HashSet<String>,
    wholes: HashMap<String, String>,
    tasks_open: bool,
    picked: HashMap<String, Vec<String>>, // a question's answers so far, by its ask and question
    others: HashMap<String, Entity<InputState>>, // a question's Something else…
    models: Vec<Model>,
    attached: Vec<Attachment>,
    ticking: bool,
    queueing: bool, // the composer says a message queues, while Claude works
    scroller: Entity<MessageScrollerState>,
    composer: Entity<TextareaState>,
    // where the composer was last drawn, which the window's toast rises above
    pub composer_at: std::rc::Rc<std::cell::Cell<Option<Bounds<Pixels>>>>,
    loaded: bool, // the session's socket said hello
    // A new desk chat's chip, Issue or Chat: what its first message makes it, as last picked (composer.rs).
    start_as_chat: bool,
    // Opened by you, from New chat or a chat's row: the composer takes the cursor once the chat shows nothing said yet,
    // and a chat with words opens to read, as the web's openSession ("unless i open an empty chat, don't focus on
    // composer", the user, 21 Oct).
    pub wants_focus: bool,
    focus_now: bool,
    folder_menu: Option<(Entity<Picker>, Subscription)>, // the folder chip's menu, open
    folder_chip: std::rc::Rc<std::cell::Cell<Option<Bounds<Pixels>>>>,
    _subscriptions: Vec<Subscription>,
    // Following its session: dropped with the chat, which closes the session's socket. Detached, it outlived the chat
    // and kept its thread, its socket and desk's note that the chat is shown, until the session said something more.
    _follow: Option<Task<()>>,
}

pub fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

// How long since a moment: 12s, 3m 4s, 1h 5m.
pub fn elapsed(from: u64) -> String {
    let secs = if from == 0 { 0 } else { (now().saturating_sub(from) + 500) / 1000 };
    if secs < 60 { format!("{secs}s") } else if secs < 3600 { format!("{}m {}s", secs / 60, secs % 60) } else { format!("{}h {}m", secs / 3600, secs / 60 % 60) }
}

fn words(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

impl Chat {
    // An issue's chat, by its slug: its page says which session it is.
    pub fn new(slug: String, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let page = format!("/api/page/issue/{slug}");
        let follow = cx.spawn(async move |this, cx| {
            let found = cx.background_spawn(async move { net::get(&page) }).await;
            let session = match found {
                Ok(page) => page["issue"]["session"].as_str().map(str::to_string),
                Err(error) => {
                    let _ = this.update(cx, |chat, cx| { chat.error = Some(error); cx.notify() });
                    return;
                }
            };
            let Some(session) = session else {
                let _ = this.update(cx, |chat, cx| { chat.error = Some("This issue has no chat yet.".into()); cx.notify() });
                return;
            };
            Self::follow(this, session, cx).await;
        });
        Self { _follow: Some(follow), ..Self::empty(window, cx) }
    }

    // Its session, once desk named it: the Inbox follows it to whichever row holds it now.
    pub fn session(&self) -> Option<&str> {
        self.session.as_deref()
    }

    // A chat by its session, as an Inbox row names one with no issue.
    pub fn of_session(session: String, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let follow = cx.spawn(async move |this, cx| Self::follow(this, session, cx).await);
        Self { _follow: Some(follow), ..Self::empty(window, cx) }
    }

    async fn follow(this: WeakEntity<Self>, session: String, cx: &mut AsyncApp) {
        let (send, events) = smol::channel::unbounded();
        live::follow(session.clone(), send);
        if this.update(cx, |chat, _| chat.session = Some(session)).is_err() { return }
        while let Ok(event) = events.recv().await {
            if this.update(cx, |chat, cx| chat.apply(event, cx)).is_err() { break }
        }
    }

    fn empty(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let scroller = cx.new(|cx| MessageScrollerState::new(0, cx));
        let composer = cx.new(|cx| TextareaState::new(window, cx).auto_grow(1, 10).submit_on_enter(true).placeholder("Reply…"));
        let subscriptions = vec![cx.subscribe_in(&composer, window, |chat, _, event: &InputEvent, window, cx| match event {
            InputEvent::PressEnter { shift: false, .. } => chat.submit(window, cx),
            InputEvent::Change => cx.notify(), // Send lights up once there is something to send
            _ => {}
        })];
        // Claude Code's models change only with Claude Code: asked once, for the model chip's menu.
        cx.spawn(async move |this, cx| {
            if let Ok(models) = cx.background_spawn(async { live::models() }).await {
                let _ = this.update(cx, |chat, _| chat.models = models);
            }
        })
        .detach();
        Self {
            session: None,
            items: Vec::new(),
            results: HashMap::new(),
            partial: Vec::new(),
            working: false,
            since: 0,
            asks: Vec::new(),
            tasks: Vec::new(),
            status: Value::Null,
            meta: Value::Null,
            pending: Vec::new(),
            error: None,
            rows: Vec::new(),
            closed: HashSet::new(),
            opened: HashSet::new(),
            wholes: HashMap::new(),
            tasks_open: false,
            picked: HashMap::new(),
            others: HashMap::new(),
            models: Vec::new(),
            attached: Vec::new(),
            ticking: false,
            queueing: false,
            scroller,
            composer,
            composer_at: Default::default(),
            loaded: false,
            start_as_chat: composer::started_as_chat(),
            wants_focus: false,
            focus_now: false,
            folder_menu: None,
            folder_chip: Default::default(),
            _subscriptions: subscriptions,
            _follow: None,
        }
    }

    fn apply(&mut self, event: Event, cx: &mut Context<Self>) {
        match event {
            Event::Hello { items, working, asks, partial, meta } => {
                self.items.clear();
                self.results.clear();
                self.take(items);
                self.set_working(working, None);
                self.asks = asks;
                self.partial = partial;
                self.tasks.clear();
                self.status = Value::Null;
                self.meta = meta;
                self.rows.clear();
                self.scroller.update(cx, |s, cx| s.reset(0, cx));
                self.loaded = true;
                if std::mem::take(&mut self.wants_focus) && self.quiet() { self.focus_now = true }
            }
            Event::Items(items) => self.take(items),
            Event::Stream(piece) => match self.partial.iter_mut().find(|b| b.msg == piece.msg && b.index == piece.index) {
                Some(block) => block.text.push_str(&piece.text),
                None => self.partial.push(piece),
            },
            Event::Working { working, since, asks, tasks, status, partial } => {
                self.set_working(working, since);
                if let Some(asks) = asks { self.asks = asks }
                if let Some(tasks) = tasks { self.tasks = tasks }
                if let Some(status) = status { self.status = status }
                if let Some(partial) = partial { self.partial = partial }
                if !working { self.partial.clear() }
            }
            Event::Asks(asks) => self.asks = asks,
            Event::Tasks(tasks) => self.tasks = tasks,
            Event::Status(status) => self.status = status,
            Event::Meta(meta) => self.meta = meta,
        }
        self.asks_changed();
        self.tick(cx);
        self.relayout(cx);
        cx.notify();
    }

    fn set_working(&mut self, on: bool, since: Option<u64>) {
        if on && (since.is_some() || !self.working) { self.since = since.unwrap_or_else(now) }
        self.working = on;
    }

    // Items now in the transcript: a result goes beside its step, a block in it stops streaming, with the reply's blocks
    // before it, and a message of the user's is no longer pending.
    fn take(&mut self, items: Vec<Item>) {
        for item in items {
            if item.kind == "result" {
                self.results.insert(item.id.clone(), item);
                continue;
            }
            if !item.msg.is_empty() {
                let kind = if item.kind == "tool" { "tool_use" } else { item.kind.as_str() };
                if let Some(done) = self.partial.iter().find(|b| b.msg == item.msg && b.kind == kind).map(|b| b.index) {
                    self.partial.retain(|b| b.msg != item.msg || b.index > done);
                }
            }
            if item.kind == "you" { self.arrived(&item.text) }
            self.items.push(item);
        }
    }

    // One pending message, or several in a row that Claude Code read as one, joined by line breaks.
    fn arrived(&mut self, text: &str) {
        let want = words(text);
        for i in 0..self.pending.len() {
            let mut joined = String::new();
            for j in i..self.pending.len() {
                joined = words(&format!("{joined} {}", self.pending[j].text));
                if joined == want {
                    self.pending.drain(i..=j);
                    return;
                }
                if !want.starts_with(&joined) { break }
            }
        }
    }

    // The questions' answers and boxes of asks no longer waiting go.
    fn asks_changed(&mut self) {
        let ids: HashSet<String> = self.asks.iter().map(|a| a.id.clone()).collect();
        let live = |key: &String| ids.contains(key.split('\u{0}').next().unwrap_or(""));
        self.picked.retain(|k, _| live(k));
        self.others.retain(|k, _| live(k));
    }

    // While a turn runs or something runs beside it, its seconds count up.
    fn tick(&mut self, cx: &mut Context<Self>) {
        if self.ticking || !(self.working || !self.tasks.is_empty()) { return }
        self.ticking = true;
        cx.spawn(async move |this, cx| loop {
            cx.background_executor().timer(Duration::from_secs(1)).await;
            let on = this.update(cx, |chat, cx| {
                chat.ticking = chat.working || !chat.tasks.is_empty();
                cx.notify();
                chat.ticking
            });
            if !matches!(on, Ok(true)) { break }
        })
        .detach();
    }

    // What the conversation shows now, row by row, as the web app's rowsOf and Conversation lay it out.
    fn rows_of(&self) -> Vec<Row> {
        let mut kinds: Vec<Kind> = Vec::new();
        for (n, item) in self.items.iter().enumerate() {
            if item.kind == "tool" && item.name == "Bash" {
                if let Some(sent) = turn::sent(item, self.results.get(&item.id)) {
                    kinds.push(Kind::Sent(n, sent));
                    continue;
                }
            }
            match item.kind.as_str() {
                "tool" | "thinking" => match kinds.last_mut() {
                    Some(Kind::Steps(list, _)) => list.push(n),
                    _ => kinds.push(Kind::Steps(vec![n], false)),
                },
                "you" => kinds.push(Kind::You(n)),
                "text" => kinds.push(Kind::Text(n)),
                "note" | "came" => kinds.push(Kind::Note(n)),
                _ => {}
            }
        }
        // One sent while Claude was idle started the reply streaming now, so it goes above it, with any sent before it;
        // those queued since go below.
        let starts = self.pending.iter().rposition(|p| !p.mid).map_or(0, |i| i + 1);
        let tail = self.working && starts == 0; // the last fold is the reply's own, and takes its steps streaming now
        let live_steps = self.partial.iter().any(|b| b.kind == "tool_use" || b.kind == "thinking");
        let tail_takes = tail && matches!(kinds.last(), Some(Kind::Steps(..)));
        if tail_takes {
            if let Some(Kind::Steps(_, live)) = kinds.last_mut() { *live = true }
        }
        kinds.extend((0..starts).map(Kind::Pending));
        if live_steps && !tail_takes { kinds.push(Kind::LiveSteps) }
        let texts = self.partial.iter().filter(|b| b.kind == "text").count();
        kinds.extend((0..texts).map(Kind::Streaming));
        kinds.extend((starts..self.pending.len()).map(Kind::Pending));
        if self.working && texts == 0 && self.asks.is_empty() { kinds.push(Kind::Working) }
        kinds.into_iter().map(|kind| Row { sig: self.sig(&kind), kind }).collect()
    }

    fn sig(&self, kind: &Kind) -> u64 {
        let mut h = DefaultHasher::new();
        match kind {
            Kind::Steps(list, live) => {
                let first = &self.items[list[0]].key;
                self.closed.contains(first).hash(&mut h);
                for &n in list {
                    let item = &self.items[n];
                    self.results.get(&item.id).map(|r| r.text.len()).hash(&mut h);
                    self.opened.contains(&item.key).hash(&mut h);
                    self.wholes.contains_key(&item.id).hash(&mut h);
                }
                if *live { self.live_steps().hash(&mut h) }
            }
            Kind::LiveSteps => self.live_steps().hash(&mut h),
            Kind::Streaming(n) => self.streaming(*n).len().hash(&mut h),
            Kind::Pending(n) => (self.pending[*n].mid && self.working).hash(&mut h),
            Kind::Sent(n, _) => self.results.contains_key(&self.items[*n].id).hash(&mut h),
            _ => {}
        }
        h.finish()
    }

    fn live_steps(&self) -> Vec<Block> {
        self.partial.iter().filter(|b| b.kind == "tool_use" || b.kind == "thinking").map(|b| Block { text: String::new(), ..b.clone() }).collect()
    }

    fn streaming(&self, n: usize) -> &str {
        self.partial.iter().filter(|b| b.kind == "text").nth(n).map_or("", |b| b.text.as_str())
    }

    // The rows from the first one a change touched are laid out again; a row changed in place only is measured again.
    fn relayout(&mut self, cx: &mut Context<Self>) {
        let new = self.rows_of();
        let old = std::mem::replace(&mut self.rows, new);
        let rows = &self.rows;
        let Some(first) = old.iter().zip(rows).position(|(a, b)| a != b).or((old.len() != rows.len()).then(|| old.len().min(rows.len()))) else { return };
        if old.len() == rows.len() {
            let last = old.iter().zip(rows).rposition(|(a, b)| a != b).unwrap_or(first);
            self.scroller.update(cx, |s, cx| { s.remeasure_items(first..last + 1, cx); });
        } else {
            let (from, to) = (old.len(), rows.len());
            self.scroller.update(cx, |s, cx| { s.splice(first..from, to - first, cx); });
        }
    }

    // A fold, a step, a thought or a command's output opened or closed.
    fn toggle(&mut self, set: fn(&mut Self) -> &mut HashSet<String>, key: String, cx: &mut Context<Self>) {
        let keys = set(self);
        if !keys.remove(&key) { keys.insert(key); }
        self.relayout(cx);
        cx.notify();
    }

    fn submit(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let text = self.composer.read(cx).value().trim().to_string();
        if self.session.is_none() || (text.is_empty() && self.attached.is_empty()) { return }
        let attached = std::mem::take(&mut self.attached);
        self.composer.update(cx, |c, cx| c.set_value("", window, cx));
        self.say(text, attached, cx);
    }

    // Nothing said in it yet, by you or Claude.
    fn quiet(&self) -> bool {
        self.items.is_empty() && self.pending.is_empty() && !self.working
    }

    // A new desk chat that nobody has written in yet, whose chips still pick what it becomes and where it runs.
    fn fresh(&self) -> bool {
        let m = &self.meta;
        m["chat"].as_bool().unwrap_or(false) && m["agent"].is_null() && !m["bare"].as_bool().unwrap_or(false) && m["issue"].is_null() && self.quiet()
    }

    // The chat's title as desk names it: its issue's, the one you gave it, or its first words.
    pub fn title(&self) -> Option<String> {
        self.meta["title"].as_str().filter(|t| !t.is_empty()).map(str::to_string)
    }

    // The folder the chat runs in, which its head shows while it has no issue: a new Chat's is the home folder until
    // one is picked.
    pub fn starts_in(&self) -> String {
        if self.fresh() && !self.meta["picked"].as_bool().unwrap_or(false) && self.start_as_chat { return "~".into() }
        self.meta["folder"].as_str().unwrap_or("").to_string()
    }

    // What an empty chat says, as the web's .convo-empty: who you talk to, and how.
    fn empty_line(&self) -> Option<String> {
        if !self.loaded { return Some("Connecting…".into()) }
        if !self.quiet() { return None }
        let m = &self.meta;
        let chat = m["chat"].as_bool().unwrap_or(false);
        Some(if let Some(agent) = m["agent"].as_str() {
            format!("Talk to {agent}.")
        } else if chat && !m["issue"].is_null() {
            "This issue's chat. Write to carry the issue on: it starts from the issue's document.".into()
        } else if m["bare"].as_bool().unwrap_or(false) || (chat && self.start_as_chat) {
            let at = self.starts_in();
            let at = if at == "~" { "from your home folder".to_string() } else { format!("in {at}") };
            format!("Just Claude, as claude runs in a terminal {at}: no issue and no desk instructions.")
        } else if chat {
            "Ask desk's agent anything: it files the work and does it here. Start with @ and a name to talk to one of your agents.".into()
        } else {
            "Nothing said yet.".into()
        })
    }

    pub fn focus_composer(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.composer.update(cx, |c, cx| c.focus(window, cx));
    }

    // A message to the session, from the composer or from a comment on lines in Changes: drawn at once as pending, and
    // dropped again with what went wrong if desk refuses it.
    pub fn say(&mut self, text: String, attached: Vec<live::Attachment>, cx: &mut Context<Self>) {
        let Some(session) = self.session.clone() else { return };
        let as_chat = self.start_as_chat && self.fresh(); // a new chat's first message, its chip on Chat
        self.pending.push(Pending { text: text.clone(), files: attached.len(), mid: self.working });
        if !self.working { self.set_working(true, None) } // drawn at once; the server's word follows
        self.tick(cx);
        self.relayout(cx);
        cx.notify();
        let uuid = uuid::Uuid::new_v4().to_string();
        cx.spawn(async move |this, cx| {
            let sent = cx.background_spawn(async move { live::send(&session, &uuid, &text, &attached, as_chat) }).await;
            let _ = this.update(cx, |chat, cx| {
                if let Err(error) = sent {
                    chat.pending.pop();
                    chat.error = Some(error);
                    chat.relayout(cx);
                }
                cx.notify()
            });
        })
        .detach();
    }

    // A call to the session in the background; what goes wrong shows under the conversation.
    fn call(&mut self, cx: &mut Context<Self>, call: impl FnOnce(&str) -> Result<Value, String> + Send + 'static) {
        let Some(session) = self.session.clone() else { return };
        cx.spawn(async move |this, cx| {
            let done = cx.background_spawn(async move { call(&session) }).await;
            let _ = this.update(cx, |chat, cx| { chat.error = done.err(); cx.notify() });
        })
        .detach();
    }

    fn interrupt(&mut self, cx: &mut Context<Self>) {
        self.call(cx, live::interrupt);
    }

    // One row of the conversation, in the column.
    fn row(&self, i: usize, this: &WeakEntity<Self>, cx: &App) -> AnyElement {
        let theme = cx.theme();
        let column = |child: AnyElement| div().w_full().flex().justify_center().px_6().child(div().w_full().max_w(px(COLUMN)).child(child));
        let Some(row) = self.rows.get(i) else { return div().into_any_element() };
        let you = |text: String, files: usize, queued: bool| {
            let shown = if files == 0 { text } else if text.is_empty() { format!("{files} attached") } else { format!("{text}\n{files} attached") };
            div()
                .v_flex()
                .items_end()
                .py_3()
                .gap_1()
                .child(
                    div()
                        .max_w(relative(0.8))
                        .px_4()
                        .py_2()
                        .rounded(px(12.))
                        .bg(theme.muted)
                        .text_size(px(DOCUMENT))
                        .text_color(theme::text(cx).strong)
                        .when(queued, |b| b.opacity(0.6))
                        .child(shown),
                )
                .when(queued, |b| b.child(div().text_xs().text_color(theme::text(cx).dim).child("Queued")))
                .into_any_element()
        };
        let inner = match &row.kind {
            Kind::You(n) => you(self.items[*n].text.clone(), 0, false),
            Kind::Pending(n) => {
                let p = &self.pending[*n];
                you(p.text.clone(), p.files, p.mid && self.working)
            }
            Kind::Text(n) => div()
                .py_2()
                .text_size(px(DOCUMENT))
                .line_height(relative(1.6))
                .child(TextView::markdown(("md", *n), self.items[*n].text.clone()).selectable(true))
                .into_any_element(),
            Kind::Streaming(n) => div()
                .py_2()
                .text_size(px(DOCUMENT))
                .line_height(relative(1.6))
                .child(TextView::markdown(("streaming", *n), self.streaming(*n).to_string()).selectable(true))
                .into_any_element(),
            Kind::Note(n) => div()
                .py_2()
                .text_center()
                .text_xs()
                .text_color(theme.muted_foreground)
                .child(self.items[*n].text.clone())
                .into_any_element(),
            Kind::Sent(_, what) => div()
                .h_flex()
                .py_1()
                .gap_2()
                .text_size(px(13.))
                .text_color(theme.muted_foreground)
                .child(theme::glyph("steps", theme.muted_foreground).size(px(14.)))
                .child(what.clone())
                .into_any_element(),
            Kind::Steps(list, live) => self.fold(list, *live, this, cx),
            Kind::LiveSteps => self.fold(&[], true, this, cx),
            Kind::Working => self.working_line(cx),
        };
        column(inner).into_any_element()
    }
}

impl Render for Chat {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme();
        let this = cx.entity().downgrade();
        let rows = this.clone();
        let column = |child: Div| div().w_full().flex().justify_center().px_6().child(child.w_full().max_w(px(COLUMN)));
        let error = self.error.clone();
        let muted = theme.muted_foreground;
        if std::mem::take(&mut self.focus_now) {
            cx.defer_in(window, |chat, window, cx| chat.focus_composer(window, cx));
        }
        let empty = self.empty_line().map(|line| {
            div().absolute().top(px(48.)).left_0().right_0().px(px(36.)).flex().justify_center()
                .child(div().max_w(px(COLUMN)).text_center().text_size(px(13.)).text_color(muted).child(line))
        });
        div()
            .v_flex()
            .size_full()
            .child(
                div().relative().flex_1().min_h_0().child(
                    MessageScroller::new("chat", self.scroller.clone(), move |i, _, cx| {
                        let Some(chat) = rows.upgrade() else { return div().into_any_element() };
                        chat.read(cx).row(i, &rows, cx)
                    })
                    .size_full(),
                )
                .children(empty),
            )
            .when_some(error, |page, error| page.child(column(div().pb_2().text_xs().text_color(muted).child(error))))
            .child(self.running(cx))
            .children(self.ask_cards(window, cx))
            .child(column(self.composer_box(window, cx)).pb_4())
            .children(self.folder_menu_shown())
    }
}
