// A Slack thread's, DM's or mail thread's row in the Inbox, open on the right, as the web app's (inbox/Thread.tsx): what
// came in from Slack or Gmail that the firewall let through. Its messages, oldest first, under the firewall's line on why
// it reached you, with Ask Claude and Open in Slack or Gmail in its head; a Slack message's files as cards and its
// reactions as pills, yours with an accent edge, and under the mouse a bar of four quick reactions and the picker.
//
// The box under it is yours: what you write there posts to Slack as you on Enter, or on Ctrl Enter sends from Gmail,
// since a mail runs long (the server's replies.ts, yours). Only your Enter or your click sends or reacts: desk's
// server takes those only from its own page and this window, never from Claude. Ask Claude puts Claude's box in its
// place, and Esc brings yours back: what you write there starts a chat on the thread, which only you see, and the pane
// turns to it (main.rs follows the row as it becomes the chat's).
//
// A Slack or Gmail login that ended has a row of its own, which opens on what mends it.
use std::collections::HashMap;

use chrono::{Local, TimeZone};
use gpui_kit::base::StyledExt;
use gpui_kit::component::input::{Input, InputEvent, InputState, Textarea, TextareaState};
use gpui_kit::component::ActiveTheme;
use gpui_kit::prelude::FluentBuilder;
use gpui_kit::*;
use serde_json::{json, Value};

use crate::sync::InboxRow;
use crate::{emoji, net, theme};

const COLUMN: f32 = 760.;
// Slack's own four quick reactions, on the bar under the mouse.
const QUICK: [&str; 4] = ["+1", "white_check_mark", "eyes", "pray"];
const PICK_ROW: usize = 9;

#[derive(Clone)]
struct Reaction {
    name: String,
    count: i64,
    mine: bool,
}

struct File {
    name: String,
    kind: String,
    size: Option<u64>,
    link: String,
}

struct Message {
    id: String,
    source: String,
    place: String,
    who: String,
    text: String,
    link: String,
    at: f64,
    verdict: Option<String>,
    why: String,
    mine: bool,
    desk: bool,
    reactions: Vec<Reaction>,
    files: Vec<File>,
}

fn text(v: &Value) -> String {
    v.as_str().unwrap_or("").to_string()
}

fn message(v: &Value) -> Message {
    Message {
        id: text(&v["id"]),
        source: text(&v["source"]),
        place: text(&v["place"]),
        who: text(&v["who"]),
        text: text(&v["text"]),
        link: text(&v["link"]),
        at: v["at"].as_f64().unwrap_or(0.),
        verdict: v["verdict"].as_str().map(str::to_string),
        why: text(&v["why"]),
        mine: v["mine"].as_bool().unwrap_or(false),
        desk: v["desk"].as_bool().unwrap_or(false),
        reactions: v["reactions"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|r| Reaction { name: text(&r["name"]), count: r["count"].as_i64().unwrap_or(0), mine: r["mine"].as_bool().unwrap_or(false) })
            .collect(),
        files: v["files"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|f| File { name: text(&f["name"]), kind: text(&f["kind"]), size: f["size"].as_u64(), link: text(&f["link"]) })
            .collect(),
    }
}

// When a message came: 08:41 today, Nov 1, 20:45 before.
fn when(at: f64) -> String {
    let Some(t) = Local.timestamp_opt(at as i64, 0).single() else { return String::new() };
    let format = if t.date_naive() == Local::now().date_naive() { "%H:%M" } else { "%b %-d, %H:%M" };
    t.format(format).to_string()
}

// What the thread is, beside its name: a channel's thread by whose it is, as Slack's own head says.
fn kind_of(n: &Message, root: Option<&Message>, thread: &str) -> String {
    if n.source == "mail" {
        return if n.place == "mail" { "Mail".into() } else { format!("Mail{}", n.place.get(4..).unwrap_or("")) };
    }
    if n.place == "DM" { return "DM · Slack".into() }
    if n.place.starts_with("group DM") { return "Group DM · Slack".into() }
    match root {
        Some(root) if thread.split(':').count() == 3 => {
            let whose = if root.who == "you" { "your thread".to_string() } else { format!("{}’s thread", root.who) };
            format!("{whose} · Slack")
        }
        _ => "Slack".into(),
    }
}

// A file's size, as Slack's card says it: 312 B, 4 KB, 1.2 MB.
fn size_of(bytes: Option<u64>) -> String {
    let Some(bytes) = bytes else { return String::new() };
    if bytes < 1024 { return format!("{bytes} B") }
    let kb = bytes as f64 / 1024.;
    if kb < 1024. { return format!("{} KB", kb.round()) }
    let mb = kb / 1024.;
    if mb < 10. { format!("{mb:.1} MB") } else { format!("{} MB", mb.round()) }
}

// The door's whys (the server's notices.ts, RULED), as the line on why it reached you says them.
fn ruled(why: &str) -> Option<&'static str> {
    match why {
        "a DM" => Some("a DM to you"),
        "a group DM" => Some("a group DM with you"),
        "@you" => Some("it mentions you"),
        "a reply in your thread" => Some("a reply in your thread"),
        _ => None,
    }
}

fn initial(who: &str) -> String {
    who.trim().chars().next().map(|c| c.to_uppercase().collect()).unwrap_or_else(|| "?".into())
}

// Where your reply goes: in whose thread in which channel, to whom in a DM or by mail (where.ts, whereTo). A mail goes
// to the thread's last sender who is not you, as Gmail's Reply.
struct Where {
    mail: bool,
    chip: String,
    whom: String,
    placeholder: String,
}

fn where_to(thread: &str, all: &[Message]) -> Where {
    let (Some(last), Some(root)) = (all.last(), all.first()) else {
        return Where { mail: false, chip: String::new(), whom: String::new(), placeholder: String::new() };
    };
    let mail = last.source == "mail";
    let them = all.iter().rev().find(|n| !n.mine).map(|n| n.who.clone()).unwrap_or_else(|| last.who.clone());
    let at = |chip: String, whom: String, placeholder: String| Where { mail, chip, whom, placeholder };
    if mail { return at(format!("to {them}"), format!("to {them}"), format!("Reply to {them}, as you")) }
    if last.place == "DM" { return at(format!("DM with {them}"), format!("to {them}"), format!("Reply to {them}, as you")) }
    if last.place.starts_with("group DM") {
        return at(format!("G{}", &last.place[1..]), format!("in the {}", last.place), "Reply in the group DM, as you".into());
    }
    if thread.split(':').count() != 3 {
        return at(last.place.clone(), format!("in {}", last.place), format!("Reply in {}, as you", last.place));
    }
    let whose = if root.mine { "your".to_string() } else { format!("{}’s", root.who) };
    at(format!("{}, in {whose} thread", last.place), format!("in {}, in {whose} thread", last.place), format!("Reply in {whose} thread, as you"))
}

// An id in a path: a thread's has colons.
fn path_part(id: &str) -> String {
    id.replace('%', "%25").replace(':', "%3A").replace('/', "%2F")
}

// The colours of desk.css the pane uses that the theme has no names for.
struct Colours {
    strong: Hsla,
    text: Hsla,
    muted: Hsla,
    dim: Hsla,
    raised: Hsla,
    hover: Hsla,   // --bg-hover: a message under the mouse
    active: Hsla,  // --bg-active
    edge: Hsla,    // --border-2
    pop: Hsla,     // --bg-pop
    pop_on: Hsla,  // --bg-pop-on
    pop_edge: Hsla, // --border-pop
    button: Hsla,  // --btn
    button_hover: Hsla,
    accent: Hsla,
    error: Hsla,   // --text-error
    avatar: Hsla,  // --avatar-session
    primary: Hsla,
    composer_edge: Hsla,
    dark: bool,
}

fn colours(cx: &App) -> Colours {
    let theme = cx.theme();
    let t = theme::text(cx);
    let dark = theme.mode.is_dark();
    let c = |d: u32, l: u32| -> Hsla { rgb(if dark { d } else { l }).into() };
    Colours {
        strong: t.strong,
        text: theme.foreground,
        muted: theme.muted_foreground,
        dim: t.dim,
        raised: t.raised,
        hover: c(0x1e1e20, 0xebebec),
        active: theme.list_active,
        edge: c(0x232426, 0xdedede),
        pop: c(0x1b1b1d, 0xffffff),
        pop_on: c(0x29292b, 0xf1f1f1),
        pop_edge: c(0x28282b, 0xe8e8e8),
        button: c(0x1b1c1d, 0xffffff),
        button_hover: t.button,
        accent: t.accent,
        error: c(0xf2994a, 0xd04608),
        avatar: rgb(0x8584d6).into(),
        primary: theme.primary,
        composer_edge: theme.border,
        dark,
    }
}

pub enum ThreadEvent {
    // you asked Claude: the pane turns to the chat on the thread
    Chat(String),
}

// The emoji picker, open under what opened it: for a message's reaction, or for your box.
struct Picking {
    message: Option<String>,
    at: Point<Pixels>,
    query: Entity<InputState>,
    rows: UniformListScrollHandle,
    _typed: Subscription,
}

pub struct ThreadPage {
    pub row: InboxRow,
    messages: Vec<Message>,
    me: Option<String>,
    login: Option<Value>,
    error: Option<String>,
    loaded: bool,
    read_at: f64, // the row's moment the thread was read at: a newer one reads it again
    asking: bool,
    yours: Entity<TextareaState>,
    ask: Entity<TextareaState>,
    mail_box: bool, // your box is a mail's: Enter makes a new line and Ctrl Enter sends
    busy: bool,
    refused: Option<String>,
    clicked: HashMap<String, Vec<Reaction>>, // your reactions as you clicked them, until the thread is read again
    hovered: Option<String>,
    picking: Option<Picking>,
    scroll: ScrollHandle,
    _subscriptions: Vec<Subscription>,
}

impl EventEmitter<ThreadEvent> for ThreadPage {}

impl ThreadPage {
    pub fn new(row: InboxRow, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let yours = cx.new(|cx| TextareaState::new(window, cx).auto_grow(1, 10).submit_on_enter(true));
        let ask = cx.new(|cx| TextareaState::new(window, cx).auto_grow(1, 10).submit_on_enter(true).placeholder("Ask Claude about it: draft a reply, file it, look into it"));
        let subscriptions = vec![
            cx.subscribe_in(&yours, window, |page, _, event: &InputEvent, window, cx| match event {
                InputEvent::PressEnter { secondary, shift } if (if page.mail_box { *secondary } else { !*shift }) => page.send(window, cx),
                InputEvent::Change => cx.notify(),
                _ => {}
            }),
            cx.subscribe_in(&ask, window, |page, _, event: &InputEvent, window, cx| match event {
                InputEvent::PressEnter { shift: false, .. } => page.ask_claude(window, cx),
                InputEvent::Change => cx.notify(),
                _ => {}
            }),
        ];
        let mut page = Self {
            read_at: row.at,
            row,
            messages: Vec::new(),
            me: None,
            login: None,
            error: None,
            loaded: false,
            asking: false,
            yours,
            ask,
            mail_box: false,
            busy: false,
            refused: None,
            clicked: HashMap::new(),
            hovered: None,
            picking: None,
            scroll: ScrollHandle::new(),
            _subscriptions: subscriptions,
        };
        page.load(window, cx);
        page
    }

    // The thread, asked of desk when it opens, when its row moves, and after you sent or reacted: the window holds no
    // notices.
    fn load(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let path = format!("/api/page/thread?id={}", path_part(&self.row.slug));
        let handle = window.window_handle();
        cx.spawn(async move |this, cx| {
            let got = cx.background_spawn(async move { net::get(&path) }).await;
            let _ = handle.update(cx, |_, window, cx| {
                this.update(cx, |page, cx| {
                    page.loaded = true;
                    match got {
                        Ok(data) => {
                            page.error = None;
                            page.login = data.get("login").filter(|l| l.is_object()).cloned();
                            page.me = data["me"].as_str().filter(|me| !me.is_empty()).map(str::to_string);
                            page.messages = data["messages"].as_array().into_iter().flatten().map(message).collect();
                            page.clicked.clear();
                            let mail = page.messages.last().is_some_and(|m| m.source == "mail");
                            let to = where_to(&page.row.slug, &page.messages);
                            page.mail_box = mail;
                            page.yours.update(cx, |box_, cx| {
                                box_.set_placeholder(to.placeholder.clone(), window, cx);
                                box_.set_submit_on_enter(!mail, cx);
                            });
                        }
                        Err(error) => page.error = Some(if error.contains("404") { "That thread is gone.".into() } else { error }),
                    }
                    cx.notify();
                })
            });
        })
        .detach();
    }

    // Its row moved: something new came in it.
    pub fn moved(&mut self, row: InboxRow, window: &mut Window, cx: &mut Context<Self>) {
        let newer = row.at > self.read_at;
        self.row = row;
        if newer {
            self.read_at = self.row.at;
            self.load(window, cx);
        }
    }

    // Your reply, as you: to Slack, or from Gmail. It shows in the thread once desk reads it again; a refusal keeps your
    // text, with the reason under it.
    fn send(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let words = self.yours.read(cx).value().trim().to_string();
        if words.is_empty() || self.busy { return }
        let to = where_to(&self.row.slug, &self.messages);
        self.busy = true;
        self.refused = None;
        cx.notify();
        let path = format!("/api/threads/{}/send", path_part(&self.row.slug));
        let handle = window.window_handle();
        cx.spawn(async move |this, cx| {
            let done = cx.background_spawn(async move { net::post(&path, json!({"text": words, "whom": to.whom})) }).await;
            let _ = handle.update(cx, |_, window, cx| {
                this.update(cx, |page, cx| {
                    page.busy = false;
                    match done {
                        Ok(_) => {
                            page.yours.update(cx, |b, cx| b.set_value("", window, cx));
                            page.load(window, cx);
                        }
                        Err(error) => page.refused = Some(error),
                    }
                    cx.notify();
                })
            });
        })
        .detach();
    }

    // What you wrote to Claude starts a chat on the thread, which the pane turns to.
    fn ask_claude(&mut self, _window: &mut Window, cx: &mut Context<Self>) {
        let words = self.ask.read(cx).value().trim().to_string();
        if words.is_empty() || self.busy { return }
        self.busy = true;
        cx.notify();
        let thread = self.row.slug.clone();
        cx.spawn(async move |this, cx| {
            let done = cx.background_spawn(async move { net::post("/api/threads/chat", json!({"thread": thread, "text": words})) }).await;
            let _ = this.update(cx, |page, cx| {
                page.busy = false;
                match done.map(|answer| answer["session"].as_str().map(str::to_string)) {
                    Ok(Some(session)) => cx.emit(ThreadEvent::Chat(session)),
                    Ok(None) => page.refused = Some("desk started no chat".into()),
                    Err(error) => page.refused = Some(error),
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn set_asking(&mut self, asking: bool, window: &mut Window, cx: &mut Context<Self>) {
        self.asking = asking;
        self.refused = None;
        if asking { self.ask.update(cx, |b, cx| b.focus(window, cx)) } else { self.yours.update(cx, |b, cx| b.focus(window, cx)) }
        cx.notify();
    }

    fn reactions_of(&self, n: &Message) -> Vec<Reaction> {
        self.clicked.get(&n.id).cloned().unwrap_or_else(|| n.reactions.clone())
    }

    // Yours on the message, added or taken back, in Slack as you: on its pill, its quick bar and its picker alike. The
    // pane shows it at once and reads the thread again behind it.
    fn react(&mut self, id: String, name: String, window: &mut Window, cx: &mut Context<Self>) {
        let Some(n) = self.messages.iter().find(|m| m.id == id) else { return };
        let mut list = self.reactions_of(n);
        let on = match list.iter_mut().find(|r| r.name == name) {
            Some(had) => {
                let on = !had.mine;
                had.mine = on;
                had.count += if on { 1 } else { -1 };
                on
            }
            None => {
                list.push(Reaction { name: name.clone(), count: 1, mine: true });
                true
            }
        };
        list.retain(|r| r.count > 0);
        self.clicked.insert(id.clone(), list);
        cx.notify();
        let handle = window.window_handle();
        cx.spawn(async move |this, cx| {
            let done = cx.background_spawn(async move { net::post("/api/reactions", json!({"message": id, "name": name, "on": on})) }).await;
            let _ = handle.update(cx, |_, window, cx| {
                this.update(cx, |page, cx| {
                    if let Err(error) = done { page.refused = Some(error) }
                    page.load(window, cx);
                })
            });
        })
        .detach();
    }

    // An emoji for your box, where its caret is: its character.
    fn put(&mut self, name: &str, window: &mut Window, cx: &mut Context<Self>) {
        let emoji = emoji::char_of(name).unwrap_or_else(|| format!(":{name}:"));
        self.yours.update(cx, |b, cx| {
            b.insert(emoji, window, cx);
            b.focus(window, cx);
        });
    }

    fn pick(&mut self, message: Option<String>, at: Point<Pixels>, window: &mut Window, cx: &mut Context<Self>) {
        let query = cx.new(|cx| InputState::new(window, cx).placeholder("Search emoji"));
        let typed = cx.subscribe_in(&query, window, |page, _, event: &InputEvent, window, cx| match event {
            InputEvent::Change => cx.notify(),
            InputEvent::PressEnter { .. } => {
                if let Some(first) = page.found(cx).into_iter().find_map(|row| row.1.into_iter().next()) { page.picked(first, window, cx) }
            }
            _ => {}
        });
        query.update(cx, |q, cx| q.focus(window, cx));
        self.picking = Some(Picking { message, at, query, rows: UniformListScrollHandle::new(), _typed: typed });
        cx.notify();
    }

    fn picked(&mut self, name: String, window: &mut Window, cx: &mut Context<Self>) {
        let Some(picking) = self.picking.take() else { return };
        match picking.message {
            Some(id) => self.react(id, name, window, cx),
            None => self.put(&name, window, cx),
        }
        cx.notify();
    }

    // The picker's rows: a category's title, then its emoji nine to a row; only those whose names hold what you typed.
    fn found(&self, cx: &App) -> Vec<(Option<String>, Vec<String>)> {
        let typed = self.picking.as_ref().map(|p| p.query.read(cx).value().trim().to_lowercase()).unwrap_or_default();
        let typed = typed.trim_matches(':');
        let mut rows = Vec::new();
        for group in emoji::groups() {
            let names: Vec<String> = group.emoji.iter().filter(|e| typed.is_empty() || e.names.iter().any(|n| n.contains(typed))).map(|e| e.name.clone()).collect();
            if names.is_empty() { continue }
            rows.push((Some(group.title.clone()), Vec::new()));
            for chunk in names.chunks(PICK_ROW) { rows.push((None, chunk.to_vec())) }
        }
        rows
    }

    // A quiet button of the head, as the web's button.thread-out: a 28px pill with its glyph and its words.
    fn head_button(id: impl Into<ElementId>, glyph: &'static str, words: &'static str, on: bool, c: &Colours) -> Stateful<Div> {
        let hover = c.button_hover;
        div()
            .id(id)
            .h_flex()
            .flex_none()
            .h(px(28.))
            .px(px(10.))
            .gap(px(6.))
            .rounded_full()
            .bg(if on { c.active } else { c.button })
            .when(!on, |b| b.hover(move |s| s.bg(hover)))
            .cursor_pointer()
            .text_size(px(12.))
            .font_medium()
            .text_color(if on { c.strong } else { c.text })
            .child(theme::glyph(glyph, if on { c.strong } else { c.text }).size(px(14.)))
            .child(words)
    }

    fn why_line(tag: &str, words: String, by: String, c: &Colours) -> Div {
        div()
            .h_flex()
            .gap_2()
            .mt(px(16.))
            .px(px(12.))
            .py(px(10.))
            .border_1()
            .border_color(c.edge)
            .rounded(px(10.))
            .bg(c.raised)
            .text_size(px(13.))
            .text_color(c.text)
            .child(div().flex_none().px(px(8.)).py(px(1.)).border_1().border_color(c.edge).rounded_full().text_size(px(12.)).font_medium().text_color(c.strong).child(tag.to_string()))
            .child(div().flex_1().min_w_0().child(words))
            .child(div().flex_none().text_size(px(12.)).text_color(c.dim).child(by))
    }

    // A login that ended: since when, what refused it, and what mends it. The row leaves once desk is signed in again.
    fn login_view(&self, login: &Value, c: &Colours) -> Div {
        let slack = self.row.source.as_deref() == Some("slack");
        let words = if slack {
            "desk reads your Slack login from your Chrome, Profile 2. Log in to Slack there once: desk tries again each minute, and once it holds, reads back what came in meanwhile. Until then nothing from Slack reaches you here."
        } else {
            "desk reads Gmail with muse's Gmail login, mail/gmail-muse in pass, and Google no longer takes its refresh token: it was revoked or expired. Put a new one there, from the same client: desk tries again each minute, and once it holds, reads from where it stopped. Until then no mail reaches you here."
        };
        div()
            .v_flex()
            .child(
                div()
                    .h_flex()
                    .gap(px(12.))
                    .child(
                        div()
                            .h_flex()
                            .flex_1()
                            .min_w_0()
                            .gap(px(10.))
                            .child(div().min_w_0().truncate().text_size(px(18.)).font_medium().text_color(c.strong).child(self.row.title.clone()))
                            .child(div().flex_none().text_size(px(13.)).text_color(c.muted).child(if slack { "Slack" } else { "Mail" })),
                    )
                    .when(slack, |h| h.child(Self::head_button("open-slack", "out", "Open Slack", false, c).on_click(|_, _, cx| cx.open_url("https://ownego.slack.com")))),
            )
            .child(Self::why_line("Login", text(&login["why"]), format!("since {}", when(login["at"].as_f64().unwrap_or(0.))), c))
            .child(div().mt(px(20.)).text_size(px(14.)).line_height(px(22.4)).text_color(c.text).child(words))
            .child(div().mt(px(12.)).text_size(px(13.)).text_color(c.muted).child("This row leaves on its own once desk is signed in again."))
    }

    // A message: its avatar, who and when, its words, its files, its reactions; under the mouse, the quick bar.
    fn message_row(&self, n: &Message, c: &Colours, cx: &mut Context<Self>) -> AnyElement {
        let reacts = n.source == "slack" && n.id.starts_with("slack:"); // a reply only desk has yet takes none
        let reactions = self.reactions_of(n);
        let lit = self.hovered.as_deref() == Some(n.id.as_str());
        let who = if n.mine { self.me.clone().unwrap_or_else(|| n.who.clone()) } else { n.who.clone() };
        let white: Hsla = rgb(0xffffff).into();
        let avatar = div()
            .flex()
            .flex_none()
            .items_center()
            .justify_center()
            .size(px(28.))
            .rounded_full()
            .bg(if n.mine { c.active } else { c.avatar })
            .text_size(px(12.))
            .font_medium()
            .text_color(if n.mine { c.strong } else { white })
            .child(initial(&who));
        let sent = if n.desk { if n.link.is_empty() { " · kept, a test desk sends nothing" } else { " · from desk" } } else { "" };
        let meta = div()
            .h_flex()
            .gap_2()
            .child(div().text_size(px(13.)).font_medium().text_color(c.strong).child(n.who.clone()))
            .child(div().text_size(px(12.)).text_color(c.dim).child(format!("{}{sent}", when(n.at))));
        let words = (!n.text.is_empty()).then(|| {
            let body = div().mt(px(2.)).text_size(px(14.)).line_height(px(22.)).text_color(c.text).whitespace_normal();
            if n.source == "mail" {
                let (first, rest) = n.text.split_once('\n').unwrap_or((&n.text, ""));
                body.child(div().font_medium().text_color(c.strong).child(first.to_string())).when(!rest.is_empty(), |b| b.child(rest.to_string()))
            } else {
                body.child(n.text.clone())
            }
        });
        let files = n.files.iter().enumerate().map(|(i, f)| {
            let link = f.link.clone();
            let meta = [f.kind.clone(), size_of(f.size)].into_iter().filter(|s| !s.is_empty()).collect::<Vec<_>>().join(" · ");
            div()
                .h_flex()
                .max_w(px(460.))
                .mt(px(6.))
                .px(px(10.))
                .py(px(8.))
                .gap_2()
                .border_1()
                .border_color(c.edge)
                .rounded(px(10.))
                .bg(c.raised)
                .child(theme::glyph("file", c.muted))
                .child(div().min_w_0().truncate().text_size(px(13.)).font_medium().text_color(c.strong).child(f.name.clone()))
                .child(div().flex_1().text_size(px(12.)).text_color(c.dim).child(meta))
                .when(!link.is_empty(), |card| {
                    card.child(Self::head_button(SharedString::from(format!("file-{}-{i}", n.id)), "out", "Open in Slack", false, c).on_click(move |_, _, cx| cx.open_url(&link)))
                })
        });
        let pills = (reacts && !reactions.is_empty()).then(|| {
            let mut row = div().h_flex().flex_wrap().gap(px(4.)).mt(px(6.));
            for r in &reactions {
                let (id, name) = (n.id.clone(), r.name.clone());
                let face = emoji::char_of(&r.name).unwrap_or_else(|| format!(":{}:", r.name));
                let hover = c.active;
                row = row.child(
                    div()
                        .id(SharedString::from(format!("react-{}-{}", n.id, r.name)))
                        .h_flex()
                        .h(px(24.))
                        .px(px(8.))
                        .gap(px(5.))
                        .rounded_full()
                        .border_1()
                        .border_color(if r.mine { c.accent } else { c.edge })
                        .bg(c.raised)
                        .hover(move |s| s.bg(hover))
                        .cursor_pointer()
                        .text_size(px(12.))
                        .font_medium()
                        .text_color(if r.mine { c.strong } else { c.text })
                        .child(div().text_size(px(14.)).child(face))
                        .child(r.count.to_string())
                        .on_click(cx.listener(move |page, _, window, cx| page.react(id.clone(), name.clone(), window, cx))),
                );
            }
            let id = n.id.clone();
            let (dim, text) = (c.dim, c.text);
            let hover = c.active;
            row.child(
                div()
                    .id(SharedString::from(format!("react-add-{}", n.id)))
                    .h_flex()
                    .h(px(24.))
                    .px(px(6.))
                    .rounded_full()
                    .border_1()
                    .border_color(c.edge)
                    .bg(c.raised)
                    .hover(move |s| s.bg(hover).text_color(text))
                    .cursor_pointer()
                    .text_color(dim)
                    .child(theme::glyph("smile-plus", dim))
                    .on_click(cx.listener(move |page, e: &ClickEvent, window, cx| page.pick(Some(id.clone()), e.position(), window, cx))),
            )
        });
        let bar = (reacts && lit).then(|| {
            let mut bar = div()
                .absolute()
                .top(px(-14.))
                .right(px(8.))
                .h_flex()
                .gap(px(2.))
                .p(px(2.))
                .border_1()
                .border_color(c.pop_edge)
                .rounded(px(8.))
                .bg(c.pop)
                .shadow(vec![BoxShadow { color: hsla(0., 0., 0., if c.dark { 0.4 } else { 0.1 }), offset: point(px(0.), px(6.)), blur_radius: px(24.), spread_radius: px(0.), inset: false }]);
            for q in QUICK {
                let id = n.id.clone();
                let on = c.pop_on;
                bar = bar.child(
                    div()
                        .id(SharedString::from(format!("quick-{}-{q}", n.id)))
                        .flex()
                        .items_center()
                        .justify_center()
                        .size(px(28.))
                        .rounded(px(6.))
                        .hover(move |s| s.bg(on))
                        .cursor_pointer()
                        .text_size(px(15.))
                        .child(emoji::char_of(q).unwrap_or_default())
                        .on_click(cx.listener(move |page, _, window, cx| page.react(id.clone(), q.to_string(), window, cx))),
                );
            }
            let id = n.id.clone();
            let on = c.pop_on;
            bar.child(
                div()
                    .id(SharedString::from(format!("quick-more-{}", n.id)))
                    .flex()
                    .items_center()
                    .justify_center()
                    .size(px(28.))
                    .rounded(px(6.))
                    .hover(move |s| s.bg(on))
                    .cursor_pointer()
                    .child(theme::glyph("smile-plus", c.muted))
                    .on_click(cx.listener(move |page, e: &ClickEvent, window, cx| page.pick(Some(id.clone()), e.position(), window, cx))),
            )
        });
        let hovered = n.id.clone();
        let hover = c.hover;
        div()
            .id(SharedString::from(format!("msg-{}", n.id)))
            .relative()
            .h_flex()
            .items_start()
            .gap(px(10.))
            .mx(px(-8.))
            .px(px(8.))
            .py(px(6.))
            .rounded(px(8.))
            .when(lit, |m| m.bg(hover))
            .on_hover(cx.listener(move |page, on: &bool, _, cx| {
                if *on { page.hovered = Some(hovered.clone()) } else if page.hovered.as_deref() == Some(hovered.as_str()) { page.hovered = None }
                cx.notify();
            }))
            .child(avatar)
            .child(div().v_flex().flex_1().min_w_0().child(meta).children(words).children(files).children(pills))
            .children(bar)
            .into_any_element()
    }

    // Your box, or Claude's while you ask it: the chat's composer, its foot saying where it goes.
    fn composer(&self, window: &mut Window, cx: &mut Context<Self>) -> Div {
        let c = colours(cx);
        let state = if self.asking { &self.ask } else { &self.yours };
        let focused = state.read(cx).focus_handle(cx).is_focused(window);
        let empty = state.read(cx).value().trim().is_empty();
        let to = where_to(&self.row.slug, &self.messages);
        let white: Hsla = rgb(0xffffff).into();
        let chip = if self.asking {
            div().h_flex().gap(px(6.)).child(theme::glyph("chat", c.muted).size(px(14.))).child("Claude, only you see it")
        } else {
            div()
                .h_flex()
                .gap(px(6.))
                .min_w_0()
                .child(if to.mail { theme::glyph("envelope", c.muted).size(px(12.)).into_any_element() } else { theme::slack_mark(12.).into_any_element() })
                .child(div().min_w_0().truncate().child(to.chip.clone()))
        };
        let emoji_button = (!self.asking && !to.mail).then(|| {
            let hover = c.button_hover;
            div()
                .id("box-emoji")
                .flex()
                .flex_none()
                .items_center()
                .justify_center()
                .size(px(28.))
                .rounded_full()
                .hover(move |s| s.bg(hover))
                .cursor_pointer()
                .child(theme::glyph("smile", c.muted))
                .on_click(cx.listener(|page, e: &ClickEvent, window, cx| page.pick(None, e.position(), window, cx)))
        });
        let send = div()
            .id("box-send")
            .flex()
            .flex_none()
            .items_center()
            .justify_center()
            .size(px(28.))
            .rounded_full()
            .bg(c.primary)
            .when(empty || self.busy, |b| b.opacity(0.35))
            .cursor_pointer()
            .child(theme::glyph("send", white).size(px(14.)))
            .on_click(cx.listener(|page, _, window, cx| if page.asking { page.ask_claude(window, cx) } else { page.send(window, cx) }));
        let area: AnyElement = if self.asking {
            Textarea::new(&self.ask).appearance(false).text_size(px(14.)).into_any_element()
        } else {
            Textarea::new(&self.yours).appearance(false).text_size(px(14.)).into_any_element()
        };
        div()
            .v_flex()
            .pl_3()
            .pr_2()
            .pt(px(10.))
            .pb(px(6.))
            .rounded(px(14.))
            .border_1()
            .border_color(if focused { theme::text(cx).edge } else { c.composer_edge })
            .bg(c.raised)
            .on_key_down(cx.listener(|page, e: &KeyDownEvent, window, cx| {
                if e.keystroke.key == "escape" && page.asking {
                    page.set_asking(false, window, cx);
                    cx.stop_propagation();
                }
            }))
            .child(area)
            .when_some(self.refused.clone(), |b, refused| b.child(div().mt(px(6.)).text_size(px(12.)).text_color(c.error).child(refused)))
            .child(
                div()
                    .h_flex()
                    .mt(px(6.))
                    .gap(px(6.))
                    .child(div().h_flex().h(px(28.)).min_w_0().px(px(6.)).text_size(px(12.)).text_color(c.muted).child(chip))
                    .children(emoji_button)
                    .child(div().flex_1())
                    .child(send),
            )
    }

    fn picker(&self, picking: &Picking, cx: &mut Context<Self>) -> impl IntoElement {
        let c = colours(cx);
        let rows = self.found(cx);
        let empty = rows.is_empty();
        let typed = picking.query.read(cx).value().to_string();
        let this = cx.entity().downgrade();
        let on = c.pop_on;
        let muted = c.muted;
        let list = uniform_list("emoji-rows", rows.len(), move |range, _, _| {
            range
                .map(|i| {
                    let (title, names) = rows[i].clone();
                    match title {
                        Some(title) => div().h(px(32.)).flex().items_end().pb(px(4.)).px(px(4.)).text_size(px(12.)).font_medium().text_color(muted).child(title),
                        None => div().h_flex().h(px(32.)).children(names.into_iter().map(|name| {
                            let this = this.clone();
                            let face = emoji::char_of(&name).unwrap_or_default();
                            div()
                                .id(SharedString::from(format!("pick-{name}")))
                                .flex()
                                .flex_1()
                                .h_full()
                                .items_center()
                                .justify_center()
                                .rounded(px(6.))
                                .hover(move |s| s.bg(on))
                                .cursor_pointer()
                                .text_size(px(20.))
                                .child(face)
                                .on_click(move |_, window, cx| {
                                    let _ = this.update(cx, |page, cx| page.picked(name.clone(), window, cx));
                                })
                        })),
                    }
                })
                .collect()
        })
        .track_scroll(&picking.rows)
        .h(px(300.));
        let anchor = if picking.message.is_some() { Anchor::TopRight } else { Anchor::BottomLeft };
        deferred(
            anchored().position(picking.at).anchor(anchor).snap_to_window_with_margin(px(8.)).child(
                div()
                    .id("emoji-pick")
                    .occlude()
                    .w(px(340.))
                    .v_flex()
                    .border_1()
                    .border_color(c.pop_edge)
                    .rounded(px(8.))
                    .bg(c.pop)
                    .shadow(vec![BoxShadow { color: hsla(0., 0., 0., if c.dark { 0.4 } else { 0.1 }), offset: point(px(0.), px(7.)), blur_radius: px(32.), spread_radius: px(0.), inset: false }])
                    .on_mouse_down_out(cx.listener(|page, _, _, cx| {
                        page.picking = None;
                        cx.notify();
                    }))
                    .on_key_down(cx.listener(|page, e: &KeyDownEvent, _, cx| {
                        if e.keystroke.key == "escape" {
                            page.picking = None;
                            cx.stop_propagation();
                            cx.notify();
                        }
                    }))
                    .child(div().h(px(38.)).px(px(4.)).border_b_1().border_color(c.pop_edge).child(Input::new(&picking.query).appearance(false)))
                    .child(div().px(px(8.)).pb(px(8.)).when(empty, |d| d.child(div().px(px(4.)).py(px(12.)).text_size(px(13.)).text_color(muted).child(format!("No emoji is named “{}”", typed.trim())))).when(!empty, |d| d.child(list))),
            ),
        )
        .with_priority(1)
    }
}

impl Render for ThreadPage {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let c = colours(cx);
        let centred = |child: AnyElement| div().w_full().flex().justify_center().px(px(24.)).child(div().w_full().max_w(px(COLUMN)).child(child));
        if let Some(error) = &self.error {
            return div().size_full().flex().items_center().justify_center().text_color(c.muted).child(error.clone());
        }
        if !self.loaded {
            return div().size_full().flex().items_center().justify_center().text_color(c.muted).child("Reading the thread…");
        }
        if let Some(login) = self.login.clone() {
            return div().size_full().child(centred(div().pt(px(28.)).pb(px(40.)).child(self.login_view(&login, &c)).into_any_element()));
        }
        let all = &self.messages;
        let Some(last) = all.last() else {
            return div().size_full().flex().items_center().justify_center().text_color(c.muted).child("Nothing in this thread yet.");
        };
        // why it reached you: its newest ask that needs you, though a later reply came after it, else its newest message's
        let judged = all.iter().rev().find(|n| n.verdict.as_deref() == Some("now")).or_else(|| all.iter().rev().find(|n| n.verdict.as_deref() == Some("later")));
        let out = all.iter().rev().find(|n| !n.link.is_empty()).map(|n| n.link.clone());
        let slack_thread = self.row.slug.starts_with("slack:");
        let head = div()
            .h_flex()
            .gap(px(12.))
            .child(
                div()
                    .h_flex()
                    .flex_1()
                    .min_w_0()
                    .gap(px(10.))
                    .when(slack_thread, |n| n.child(theme::slack_mark(16.)))
                    .child(div().min_w_0().truncate().text_size(px(18.)).font_medium().text_color(c.strong).child(self.row.title.clone()))
                    .child(div().flex_none().text_size(px(13.)).text_color(c.muted).child(kind_of(last, all.first(), &self.row.slug))),
            )
            .child(Self::head_button("ask-claude", "chat", "Ask Claude", self.asking, &c).on_click(cx.listener(|page, _, window, cx| {
                let asking = !page.asking;
                page.set_asking(asking, window, cx);
            })))
            .when_some(out, |h, link| {
                let words = if last.source == "mail" { "Open in Gmail" } else { "Open in Slack" };
                h.child(Self::head_button("thread-out", "out", words, false, &c).on_click(move |_, _, cx| cx.open_url(&link)))
            });
        let why = judged.map(|j| {
            let now = j.verdict.as_deref() == Some("now");
            let words = ruled(&j.why).map(str::to_string).unwrap_or_else(|| j.why.clone());
            let words = if words.is_empty() { (if now { "needs you" } else { "can wait" }).to_string() } else { words };
            Self::why_line(if now { "Now" } else { "Later" }, words, (if ruled(&j.why).is_some() { "by rule" } else { "by Claude" }).to_string(), &c)
        });
        let messages: Vec<AnyElement> = all.iter().map(|n| self.message_row(n, &c, cx)).collect();
        let view = div().v_flex().pt(px(28.)).pb(px(40.)).child(head).children(why).child(div().v_flex().mt(px(24.)).gap(px(18.)).children(messages));
        let composer = self.composer(window, cx);
        let picker = self.picking.as_ref().map(|p| self.picker(p, cx));
        div()
            .v_flex()
            .size_full()
            .child(div().id("thread").flex_1().min_h_0().overflow_y_scroll().track_scroll(&self.scroll).child(centred(view.into_any_element())))
            .child(div().flex_none().pb(px(16.)).child(centred(composer.into_any_element())))
            .children(picker)
    }
}
